package com.example.streetsweep.tracking

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.Build
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.Observer
import androidx.lifecycle.lifecycleScope
import androidx.car.app.connection.CarConnection
import com.example.streetsweep.appContainer
import com.example.streetsweep.data.db.TrackSession
import com.example.streetsweep.domain.Geo
import com.example.streetsweep.domain.LatLngPoint
import com.example.streetsweep.domain.PointFilter
import com.example.streetsweep.domain.TrackingMode
import com.example.streetsweep.domain.TriggerSource
import com.example.streetsweep.tracking.auto.BluetoothDevices
import com.example.streetsweep.tracking.auto.CarConnectionState
import com.example.streetsweep.tracking.auto.VehicleState
import com.example.streetsweep.widget.CoverageWidget
import com.example.streetsweep.data.CoverageRepository
import com.example.streetsweep.data.osm.MatchRetryWorker
import com.example.streetsweep.data.osm.RoadMatcher
import com.example.streetsweep.data.sync.PortalPushWorker
import com.google.android.gms.location.Granularity
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.Priority
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Foreground service that records one drive ("session").
 *
 * Fixes arrive every 15 s from the fused location provider; [PointFilter] keeps only those at
 * least 50 ft from the last stored point. Automatic sessions stop after a grace period once
 * their trigger (Bluetooth device / Android Auto) disconnects, unless another trigger is still
 * connected. Manual sessions only stop when the user says so.
 */
class TrackingService : LifecycleService() {

    private val container by lazy { appContainer }
    private val filter = PointFilter()

    private var session: TrackSession? = null
    private var starting = false
    private var lastStored: LatLngPoint? = null
    private var pendingStop: Job? = null
    private var locationCallback: LocationCallback? = null

    private var carConnection: CarConnection? = null
    private var carConnected = false
    private val carObserver = Observer<Int> { type -> onCarConnectionChanged(type) }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        val trigger = TriggerSource.fromName(intent?.getStringExtra(EXTRA_TRIGGER))
        when (intent?.action) {
            ACTION_START -> handleStart(trigger)
            ACTION_STOP -> lifecycleScope.launch { finishAndStop() }
            ACTION_TRIGGER_DISCONNECTED -> handleTriggerDisconnected()
            else -> handleRestart()
        }
        return START_STICKY
    }

    // ---- lifecycle of a session -------------------------------------------------------------

    private fun handleStart(trigger: TriggerSource) {
        if (TrackingStateHolder.isRecording || starting) {
            // Trigger (re)connected while already recording: cancel any pending auto-stop.
            cancelPendingStop()
            updateNotification()
            return
        }
        if (!Permissions.hasLocation(this)) {
            Notifications.showAlert(this, "Can't record drive", "StreetSweep needs precise location permission.")
            stopSelf()
            return
        }
        if (!goForeground(Notifications.tracking(this, null))) return
        Notifications.cancelStartPrompt(this)
        starting = true
        lifecycleScope.launch {
            val s = container.trackRepository.startSession(trigger)
            session = s
            lastStored = null
            areaPromptShown = false
            TrackingStateHolder.set(TrackingStatus.Recording(sessionId = s.id, trigger = trigger, startedAt = s.startedAt))
            starting = false
            startLocationUpdates()
            startCarConnectionObserver()
            startIdleWatchdog()
            updateNotification()
            Log.i(TAG, "Session ${s.id} started via $trigger")
        }
    }

    /** START_STICKY restart after the process was killed: pick the open session back up. */
    private fun handleRestart() {
        if (TrackingStateHolder.isRecording || starting) return
        if (!Permissions.hasLocation(this) || !goForeground(Notifications.tracking(this, null))) {
            stopSelf()
            return
        }
        starting = true
        lifecycleScope.launch {
            val open = container.trackRepository.getOpenSession()
            if (open == null) {
                starting = false
                ServiceCompat.stopForeground(this@TrackingService, ServiceCompat.STOP_FOREGROUND_REMOVE)
                stopSelf()
                return@launch
            }
            session = open
            lastStored = container.trackRepository.getPoints(open.id).lastOrNull()?.let { LatLngPoint(it.latitude, it.longitude) }
            TrackingStateHolder.set(
                TrackingStatus.Recording(
                    sessionId = open.id,
                    trigger = TriggerSource.fromName(open.trigger),
                    startedAt = open.startedAt,
                    pointCount = open.pointCount,
                    distanceMeters = open.distanceMeters,
                ),
            )
            starting = false
            startLocationUpdates()
            startCarConnectionObserver()
            startIdleWatchdog()
            updateNotification()
            Log.i(TAG, "Resumed session ${open.id} after restart")
        }
    }

    private suspend fun finishAndStop() {
        cancelPendingStop()
        idleWatchdog?.cancel()
        idleWatchdog = null
        stopIntervalWatcher()
        stopLocationUpdates()
        stopCarConnectionObserver()
        val s = session
        session = null
        if (s != null) {
            container.trackRepository.endSession(s.id)
            val settings = container.settings.current()
            val app = applicationContext
            container.applicationScope.launch {
                if (settings.snapToRoadsEnabled) {
                    val result = container.roadMatcher.matchSession(s.id)
                    // Usually a lost signal; try again once there is a network.
                    if (result is RoadMatcher.Result.Failed) MatchRetryWorker.enqueueNow(app)
                }
                summariseDrive(app, s.id)
            }
            Log.i(TAG, "Session ${s.id} ended")
        }
        TrackingStateHolder.set(TrackingStatus.Idle)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /** Tells you what the drive was worth once matching has had its go. */
    private suspend fun summariseDrive(context: Context, sessionId: Long) {
        val session = container.trackRepository.getSession(sessionId) ?: return
        if (session.pointCount == 0) return
        val title = "Drive recorded · ${Geo.formatDistance(session.distanceMeters)}"
        val added = if (session.newSegments > 0) {
            "Added ${Geo.formatDistance(session.newMeters)} of streets you had not driven before."
        } else {
            "No new streets this time."
        }
        val areaLine = container.trackRepository.getPoints(sessionId).lastOrNull()?.let { last ->
            val areas = container.coverageRepository.observeAreasWithStats().first()
            CoverageRepository.deepestContaining(areas, LatLngPoint(last.latitude, last.longitude))?.let { a ->
                " ${a.name} is now ${a.stats.percent}% done, ${a.stats.remaining} streets to go."
            }
        }
        Notifications.showDriveSummary(context, title, added + (areaLine ?: ""))
        CoverageWidget.refresh(context)
        if (container.settings.current().autoPushEnabled) PortalPushWorker.enqueue(context)
    }

    // ---- automatic stop with grace period ---------------------------------------------------

    private fun handleTriggerDisconnected() {
        val current = TrackingStateHolder.status.value as? TrackingStatus.Recording ?: return
        if (!current.trigger.isAutomatic) return
        schedulePendingStop()
    }

    private fun schedulePendingStop() {
        if (pendingStop?.isActive == true) return
        val stopAt = System.currentTimeMillis() + STOP_GRACE_MS
        TrackingStateHolder.updateRecording { it.copy(stopScheduledAt = stopAt) }
        updateNotification()
        pendingStop = lifecycleScope.launch {
            delay(STOP_GRACE_MS)
            if (anyTriggerStillConnected()) {
                Log.d(TAG, "Grace period over but a trigger is still connected; continuing")
                TrackingStateHolder.updateRecording { it.copy(stopScheduledAt = null) }
                updateNotification()
            } else {
                finishAndStop()
            }
        }
    }

    private fun cancelPendingStop() {
        if (pendingStop?.isActive == true) {
            pendingStop?.cancel()
            TrackingStateHolder.updateRecording { it.copy(stopScheduledAt = null) }
        }
        pendingStop = null
    }

    private suspend fun anyTriggerStillConnected(): Boolean {
        val settings = container.settings.current()
        if (settings.mode != TrackingMode.AUTOMATIC) return false
        settings.bluetoothTriggerAddress?.let { if (BluetoothDevices.isConnected(this, it)) return true }
        if (settings.androidAutoTriggerEnabled && CarConnectionState.isConnected(this)) return true
        if (settings.inVehicleTriggerEnabled && VehicleState.inVehicle) return true
        return false
    }

    private fun startCarConnectionObserver() {
        if (carConnection != null) return
        carConnection = CarConnection(this).also { it.type.observe(this, carObserver) }
    }

    private fun stopCarConnectionObserver() {
        carConnection?.type?.removeObserver(carObserver)
        carConnection = null
        carConnected = false
    }

    private fun onCarConnectionChanged(type: Int?) {
        val connected = CarConnectionState.isConnectedType(type)
        val wasConnected = carConnected
        carConnected = connected
        val current = TrackingStateHolder.status.value as? TrackingStatus.Recording ?: return
        if (!current.trigger.isAutomatic) return
        if (wasConnected && !connected) {
            lifecycleScope.launch {
                if (container.settings.current().androidAutoTriggerEnabled) schedulePendingStop()
            }
        } else if (connected) {
            cancelPendingStop()
            updateNotification()
        }
    }

    // ---- location ---------------------------------------------------------------------------

    private var intervalWatcher: Job? = null
    private var idleWatchdog: Job? = null
    private var lastStoredAt: Long = 0L
    private var areaPromptShown = false

    /**
     * Stops a drive that has gone nowhere for a while, so a forgotten session does not sit
     * burning battery. Off by default; the 50 ft rule already keeps idle time out of the track.
     */
    private fun startIdleWatchdog() {
        if (idleWatchdog?.isActive == true) return
        lastStoredAt = System.currentTimeMillis()
        idleWatchdog = lifecycleScope.launch {
            while (true) {
                delay(60_000)
                val minutes = container.settings.current().autoStopIdleMinutes
                if (minutes <= 0) continue
                val idleFor = System.currentTimeMillis() - lastStoredAt
                if (idleFor >= minutes * 60_000L) {
                    Log.i(TAG, "Stopping after $minutes idle minutes")
                    Notifications.showAlert(
                        this@TrackingService,
                        "Recording stopped",
                        "No movement for $minutes minutes, so StreetSweep stopped the drive.",
                    )
                    finishAndStop()
                    return@launch
                }
            }
        }
    }

    /** Subscribes at the configured interval and re-subscribes if the user changes it mid-drive. */
    private suspend fun startLocationUpdates() {
        val settings = container.settings.current()
        subscribeLocation(settings.gpsIntervalMs)
        if (intervalWatcher?.isActive != true) {
            intervalWatcher = lifecycleScope.launch {
                container.settings.settings.map { it.gpsIntervalMs }.distinctUntilChanged().drop(1).collect { ms ->
                    if (locationCallback != null) {
                        Log.i(TAG, "GPS interval changed to ${ms / 1000}s; resubscribing")
                        stopLocationUpdates()
                        subscribeLocation(ms)
                    }
                }
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun subscribeLocation(intervalMs: Long) {
        if (locationCallback != null) return
        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, intervalMs)
            .setMinUpdateIntervalMillis(intervalMs)
            .setGranularity(Granularity.GRANULARITY_FINE)
            .setWaitForAccurateLocation(false)
            .build()
        val callback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                val location = result.lastLocation ?: return
                lifecycleScope.launch { onLocation(location) }
            }
        }
        locationCallback = callback
        try {
            container.fusedLocationClient.requestLocationUpdates(request, callback, Looper.getMainLooper())
        } catch (e: SecurityException) {
            Log.e(TAG, "Location permission missing", e)
            locationCallback = null
            lifecycleScope.launch { finishAndStop() }
        }
    }

    private fun stopLocationUpdates() {
        locationCallback?.let { container.fusedLocationClient.removeLocationUpdates(it) }
        locationCallback = null
    }

    private fun stopIntervalWatcher() {
        intervalWatcher?.cancel()
        intervalWatcher = null
    }

    private suspend fun onLocation(location: Location) {
        val s = session ?: return
        // The fused provider replays its cached last-known location on subscribe. If that fix
        // predates the session it can be from anywhere (last trip, another city); drop it.
        if (location.time < s.startedAt - STALE_FIX_TOLERANCE_MS) {
            Log.d(TAG, "Ignoring stale fix from ${s.startedAt - location.time} ms before session start")
            return
        }
        val point = LatLngPoint(location.latitude, location.longitude)
        val accuracy = if (location.hasAccuracy()) location.accuracy else 0f
        val now = System.currentTimeMillis()
        when (filter.evaluate(point, accuracy, lastStored)) {
            PointFilter.Decision.STORE -> {
                val added = lastStored?.let { Geo.distanceMeters(it, point) } ?: 0.0
                container.trackRepository.addPoint(
                    sessionId = s.id,
                    latitude = point.latitude,
                    longitude = point.longitude,
                    accuracyMeters = accuracy,
                    speedMps = if (location.hasSpeed()) location.speed else 0f,
                    bearing = if (location.hasBearing()) location.bearing else 0f,
                    timestamp = location.time,
                    addedDistanceMeters = added,
                )
                lastStored = point
                lastStoredAt = now
                promptIfOutsideAreas(point)
                TrackingStateHolder.updateRecording {
                    it.copy(
                        pointCount = it.pointCount + 1,
                        distanceMeters = it.distanceMeters + added,
                        lastFixAt = now,
                        lastPoint = point,
                    )
                }
                updateNotification()
                maybeSnapIncrementally(s.id)
            }
            PointFilter.Decision.TOO_CLOSE -> TrackingStateHolder.updateRecording {
                it.copy(skippedTooClose = it.skippedTooClose + 1, lastFixAt = now, lastPoint = point)
            }
            PointFilter.Decision.INACCURATE -> TrackingStateHolder.updateRecording {
                it.copy(skippedInaccurate = it.skippedInaccurate + 1, lastFixAt = now)
            }
        }
    }

    /** Coverage only counts inside an area, so say so once if this drive is outside them all. */
    private suspend fun promptIfOutsideAreas(point: LatLngPoint) {
        if (areaPromptShown) return
        areaPromptShown = true
        val areas = container.coverageRepository.observeAreasWithStats().first()
        if (areas.isEmpty() || CoverageRepository.deepestContaining(areas, point) == null) {
            Notifications.showAlert(
                this,
                "Recording outside your areas",
                "This drive is being saved and matched to streets, but it will not count toward any " +
                    "coverage figure until you add an area here from the map.",
            )
        }
    }

    private suspend fun maybeSnapIncrementally(sessionId: Long) {
        val count = (TrackingStateHolder.status.value as? TrackingStatus.Recording)?.pointCount ?: return
        if (count % SNAP_EVERY_POINTS != 0) return
        val settings = container.settings.current()
        if (!settings.snapToRoadsEnabled) return
        container.applicationScope.launch { container.roadMatcher.matchSession(sessionId) }
    }

    // ---- foreground plumbing ----------------------------------------------------------------

    private fun goForeground(notification: android.app.Notification): Boolean = try {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0
        ServiceCompat.startForeground(this, Notifications.ID_TRACKING, notification, type)
        true
    } catch (e: IllegalStateException) {
        // ForegroundServiceStartNotAllowedException on Android 12+
        Log.w(TAG, "Not allowed to start foreground service now", e)
        stopSelf()
        false
    } catch (e: SecurityException) {
        Log.w(TAG, "Missing permission for location foreground service", e)
        stopSelf()
        false
    }

    @SuppressLint("MissingPermission")
    private fun updateNotification() {
        val status = TrackingStateHolder.status.value as? TrackingStatus.Recording ?: return
        if (!Permissions.hasNotifications(this)) return
        NotificationManagerCompat.from(this).notify(Notifications.ID_TRACKING, Notifications.tracking(this, status))
    }

    override fun onDestroy() {
        stopIntervalWatcher()
        stopLocationUpdates()
        stopCarConnectionObserver()
        pendingStop?.cancel()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "TrackingService"
        const val ACTION_START = "com.example.streetsweep.action.START"
        const val ACTION_STOP = "com.example.streetsweep.action.STOP"
        const val ACTION_TRIGGER_DISCONNECTED = "com.example.streetsweep.action.TRIGGER_DISCONNECTED"
        const val EXTRA_TRIGGER = "trigger"

        /** How long an automatic session keeps recording after its trigger disconnects. */
        const val STOP_GRACE_MS = 90_000L

        /** Match the newest points to roads every N stored points while driving. */
        const val SNAP_EVERY_POINTS = 20

        /** Fixes timestamped more than this before the session started are treated as stale cache. */
        const val STALE_FIX_TOLERANCE_MS = 2_000L

        fun startIntent(context: Context, trigger: TriggerSource): Intent =
            Intent(context, TrackingService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_TRIGGER, trigger.name)

        /**
         * Starts (or re-affirms) recording. Returns false when Android refuses a background
         * foreground-service start; callers then fall back to a tap-to-start notification.
         */
        fun start(context: Context, trigger: TriggerSource): Boolean = try {
            ContextCompat.startForegroundService(context, startIntent(context, trigger))
            true
        } catch (e: IllegalStateException) {
            Log.w(TAG, "Foreground service start refused: ${e.message}")
            false
        }

        fun stop(context: Context) {
            if (!TrackingStateHolder.isRecording) return
            runCatching {
                context.startService(Intent(context, TrackingService::class.java).setAction(ACTION_STOP))
            }
        }

        fun notifyTriggerDisconnected(context: Context, trigger: TriggerSource) {
            if (!TrackingStateHolder.isRecording) return
            runCatching {
                context.startService(
                    Intent(context, TrackingService::class.java)
                        .setAction(ACTION_TRIGGER_DISCONNECTED)
                        .putExtra(EXTRA_TRIGGER, trigger.name),
                )
            }
        }
    }
}
