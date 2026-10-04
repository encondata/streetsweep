package net.streetsweep.tracking

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
import net.streetsweep.appContainer
import net.streetsweep.data.db.TrackSession
import net.streetsweep.domain.Geo
import net.streetsweep.domain.LatLngPoint
import net.streetsweep.domain.PointFilter
import net.streetsweep.domain.TrackingMode
import net.streetsweep.domain.TriggerSource
import net.streetsweep.tracking.auto.BluetoothDevices
import net.streetsweep.tracking.auto.CarConnectionState
import net.streetsweep.tracking.auto.VehicleState
import net.streetsweep.widget.CoverageWidget
import net.streetsweep.data.CoverageRepository
import net.streetsweep.data.server.SyncWorker
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
            ACTION_PAUSE -> pause()
            ACTION_RESUME -> resume()
            ACTION_STOP -> lifecycleScope.launch { finishAndStop() }
            ACTION_TRIGGER_DISCONNECTED -> handleTriggerDisconnected()
            ACTION_REFRESH_GPS -> refreshGps("asked to")
            else -> handleRestart()
        }
        return START_STICKY
    }

    // ---- lifecycle of a session -------------------------------------------------------------

    private fun handleStart(trigger: TriggerSource) {
        if (TrackingStateHolder.isRecording || starting) {
            // Trigger (re)connected while already recording: cancel any pending auto-stop.
            // If the drive was paused, this is the driver getting back in, so pick it up
            // again rather than leaving it sitting there.
            cancelPendingStop()
            if (TrackingStateHolder.isPaused) resume() else updateNotification()
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
            val (type, vehicle) = net.streetsweep.data.server.DriveDefaults.pick(container.database, container.settings, trigger)
            val s = container.trackRepository.startSession(trigger, driveTypeKey = type, vehicleId = vehicle)
            session = s
            lastStored = null
            areaPromptShown = false
            val label = net.streetsweep.data.server.DriveDefaults.label(container.database, type, vehicle)
            TrackingStateHolder.set(TrackingStatus.Recording(sessionId = s.id, trigger = trigger, startedAt = s.startedAt, driveLabel = label))
            starting = false
            startLocationUpdates()
            startCarConnectionObserver()
            startIdleWatchdog()
            startGpsWatchdog()
            updateNotification()
            Log.i(TAG, "Session ${s.id} started via $trigger")
        }
    }

    /**
     * Stops recording without ending the drive.
     *
     * Location updates stop, which is the point: a shop stop should cost nothing and add
     * nothing. The drive stays open, so what follows is the same drive rather than a
     * second one in the list.
     */
    private fun pause() {
        val current = TrackingStateHolder.status.value as? TrackingStatus.Recording ?: return
        if (current.isPaused) return
        stopLocationUpdates()
        stopIntervalWatcher()
        cancelPendingStop()
        TrackingStateHolder.updateRecording {
            it.copy(pausedAt = System.currentTimeMillis(), stopScheduledAt = null, gpsQuietSince = null)
        }
        startPauseGuard()
        updateNotification()
        Log.i(TAG, "Session ${current.sessionId} paused")
    }

    /** Picks the same drive back up, and books the time spent standing still. */
    private fun resume() {
        val current = TrackingStateHolder.status.value as? TrackingStatus.Recording ?: return
        val pausedAt = current.pausedAt ?: return
        val stoodStill = (System.currentTimeMillis() - pausedAt).coerceAtLeast(0)
        pauseGuard?.cancel()
        pauseGuard = null
        TrackingStateHolder.updateRecording { it.copy(pausedAt = null) }
        lifecycleScope.launch {
            container.trackRepository.addPausedMs(current.sessionId, stoodStill)
            // The watchdog measures time since the last stored point, and nothing was
            // stored while paused, so it has to start counting again from now.
            lastStoredAt = System.currentTimeMillis()
            startLocationUpdates()
            updateNotification()
            Log.i(TAG, "Session ${current.sessionId} resumed after ${stoodStill / 1000}s")
        }
    }

    /** A pause nobody comes back from should not hold a drive open all day. */
    private fun startPauseGuard() {
        pauseGuard?.cancel()
        pauseGuard = lifecycleScope.launch {
            delay(PAUSE_LIMIT_MS)
            if (!TrackingStateHolder.isPaused) return@launch
            val current = TrackingStateHolder.status.value as? TrackingStatus.Recording ?: return@launch
            container.trackRepository.addPausedMs(
                current.sessionId,
                (System.currentTimeMillis() - (current.pausedAt ?: 0L)).coerceAtLeast(0),
            )
            Notifications.showAlert(
                this@TrackingService,
                "Recording stopped",
                "The drive was paused for ${PAUSE_LIMIT_MS / 3_600_000} hours, so StreetSweep ended it.",
            )
            finishAndStop()
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
            startGpsWatchdog()
            updateNotification()
            Log.i(TAG, "Resumed session ${open.id} after restart")
        }
    }

    private suspend fun finishAndStop() {
        // Stopping straight from a pause still owes that stretch to the drive.
        (TrackingStateHolder.status.value as? TrackingStatus.Recording)?.pausedAt?.let { at ->
            container.trackRepository.addPausedMs(
                (TrackingStateHolder.status.value as TrackingStatus.Recording).sessionId,
                (System.currentTimeMillis() - at).coerceAtLeast(0),
            )
        }
        pauseGuard?.cancel()
        pauseGuard = null

        cancelPendingStop()
        idleWatchdog?.cancel()
        idleWatchdog = null
        gpsWatchdog?.cancel()
        gpsWatchdog = null
        stopIntervalWatcher()
        stopLocationUpdates()
        stopCarConnectionObserver()
        val s = session
        session = null
        if (s != null) {
            container.trackRepository.endSession(s.id)
            val app = applicationContext
            container.applicationScope.launch {
                // The last stretch into the preview; the server matches it properly once it's up.
                runCatching { container.provisional.update(s.id) }
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
        val covered = container.database.serverDao().provisionalStreetCount(sessionId)
        val added = if (covered > 0) {
            "About $covered street${if (covered == 1) "" else "s"} covered; the server confirms once it's uploaded."
        } else {
            "No streets matched on the phone; the server has the final word once it's uploaded."
        }
        val areaLine = container.trackRepository.getPoints(sessionId).lastOrNull()?.let { last ->
            val areas = container.coverageRepository.observeAreasWithStats().first()
            CoverageRepository.deepestContaining(areas, LatLngPoint(last.latitude, last.longitude))?.let { a ->
                " ${a.name} is now ${a.stats.percent}% done, ${a.stats.remaining} streets to go."
            }
        }
        Notifications.showDriveSummary(context, title, added + (areaLine ?: ""))
        CoverageWidget.refresh(context)
        // The server is the record, so every drive goes up as soon as there is a network.
        SyncWorker.enqueue(context)
    }

    // ---- automatic stop with grace period ---------------------------------------------------

    private fun handleTriggerDisconnected() {
        if (TrackingStateHolder.isPaused) {
            Log.i(TAG, "Trigger disconnected while paused; leaving the drive open")
            return
        }
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
    private var gpsWatchdog: Job? = null
    /** When the provider last handed over any fix at all, good or bad; and when we last subscribed. */
    private var lastFixDeliveredAt: Long = 0L
    private var subscribedAt: Long = 0L
    private var gpsAlertShown = false
    private var pauseGuard: Job? = null
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
                // Standing still is the whole point of a pause, so it is not idling.
                if (TrackingStateHolder.isPaused) continue
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

    /**
     * Notices when fixes stop arriving while a drive is running, and gets them going again.
     *
     * After a stop — parked, into a shop and back — the location provider could go quiet
     * and stay quiet once the car moved off: the drive still said "recording" and the map
     * sat where the car had been parked until the drive was stopped and started again,
     * which is nothing more than a fresh subscription. This does that by itself, without
     * splitting the drive: a fresh subscription and a request for a current fix, again
     * every half minute while nothing comes, and one alert if it lasts two minutes.
     */
    private fun startGpsWatchdog() {
        if (gpsWatchdog?.isActive == true) return
        gpsWatchdog = lifecycleScope.launch {
            while (true) {
                delay(GPS_CHECK_MS)
                val current = TrackingStateHolder.status.value as? TrackingStatus.Recording ?: continue
                if (current.isPaused || locationCallback == null) continue
                val interval = container.settings.current().gpsIntervalMs
                val quietFor = System.currentTimeMillis() - maxOf(lastFixDeliveredAt, subscribedAt)
                if (quietFor < maxOf(GPS_QUIET_MS, interval * 3)) continue
                if (current.gpsQuietSince == null) {
                    TrackingStateHolder.updateRecording {
                        it.copy(gpsQuietSince = System.currentTimeMillis() - quietFor)
                    }
                    updateNotification()
                }
                refreshGps("no fix for ${quietFor / 1000}s")
                val since = (TrackingStateHolder.status.value as? TrackingStatus.Recording)?.gpsQuietSince ?: continue
                if (!gpsAlertShown && System.currentTimeMillis() - since >= GPS_ALERT_MS) {
                    gpsAlertShown = true
                    Notifications.showAlert(
                        this@TrackingService,
                        "Not getting your location",
                        "The drive is still recording, but no GPS position has come in for " +
                            "${(System.currentTimeMillis() - since) / 60_000} minutes. StreetSweep keeps " +
                            "trying; opening the app gives it another push.",
                    )
                }
            }
        }
    }

    /**
     * A fresh subscription and a one-off request for the current position — what stopping
     * and starting the drive used to be needed for. Also run when the app is opened and
     * the last fix is old.
     */
    @SuppressLint("MissingPermission")
    private fun refreshGps(why: String) {
        val current = TrackingStateHolder.status.value as? TrackingStatus.Recording ?: return
        if (current.isPaused || session == null) return
        Log.w(TAG, "Refreshing GPS: $why")
        lifecycleScope.launch {
            stopLocationUpdates()
            subscribeLocation(container.settings.current().gpsIntervalMs)
            runCatching {
                val token = com.google.android.gms.tasks.CancellationTokenSource()
                container.fusedLocationClient
                    .getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, token.token)
                    .addOnSuccessListener { loc -> if (loc != null) lifecycleScope.launch { onLocation(loc) } }
            }.onFailure { Log.w(TAG, "Could not ask for a current fix: ${it.message}") }
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
        subscribedAt = System.currentTimeMillis()
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
        // Anything at all from the provider means it is working again.
        lastFixDeliveredAt = System.currentTimeMillis()
        (TrackingStateHolder.status.value as? TrackingStatus.Recording)?.gpsQuietSince?.let { since ->
            Log.i(TAG, "GPS back after ${(lastFixDeliveredAt - since) / 1000}s without a fix")
            gpsAlertShown = false
            TrackingStateHolder.updateRecording { it.copy(gpsQuietSince = null) }
            updateNotification()
        }
        val point = LatLngPoint(location.latitude, location.longitude)
        // Streets for a big area arrive as the car reaches them.
        net.streetsweep.data.osm.NearbyStreets.near(this, point)
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
                "This drive is being saved and matched to streets. It counts toward an area's figure " +
                    "once an area covering it is drawn on the web.",
            )
        }
    }

    private suspend fun maybeSnapIncrementally(sessionId: Long) {
        val count = (TrackingStateHolder.status.value as? TrackingStatus.Recording)?.pointCount ?: return
        if (count % SNAP_EVERY_POINTS != 0) return
        container.applicationScope.launch { runCatching { container.provisional.update(sessionId) } }
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
        const val ACTION_START = "net.streetsweep.action.START"
        const val ACTION_STOP = "net.streetsweep.action.STOP"
        const val ACTION_PAUSE = "net.streetsweep.action.PAUSE"
        const val ACTION_RESUME = "net.streetsweep.action.RESUME"
        const val ACTION_TRIGGER_DISCONNECTED = "net.streetsweep.action.TRIGGER_DISCONNECTED"
        const val ACTION_REFRESH_GPS = "net.streetsweep.action.REFRESH_GPS"
        const val EXTRA_TRIGGER = "trigger"

        /** How long an automatic session keeps recording after its trigger disconnects. */
        const val STOP_GRACE_MS = 90_000L

        /** Long enough for any errand; short of leaving a drive open overnight. */
        const val PAUSE_LIMIT_MS = 4 * 60 * 60 * 1000L

        /** How often the GPS watchdog looks, and how long a silence it lets pass. */
        const val GPS_CHECK_MS = 15_000L
        const val GPS_QUIET_MS = 30_000L
        /** A silence this long is worth telling someone about. */
        const val GPS_ALERT_MS = 2 * 60_000L

        /** Match the newest points to roads every N stored points while driving. */
        const val SNAP_EVERY_POINTS = 10

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

        fun pause(context: Context) {
            context.startService(Intent(context, TrackingService::class.java).setAction(ACTION_PAUSE))
        }

        fun resume(context: Context) {
            context.startService(Intent(context, TrackingService::class.java).setAction(ACTION_RESUME))
        }

        fun stop(context: Context) {
            if (!TrackingStateHolder.isRecording) return
            runCatching {
                context.startService(Intent(context, TrackingService::class.java).setAction(ACTION_STOP))
            }
        }

        /** The app came to the front with an old fix: give the location provider a push. */
        fun refreshGps(context: Context) {
            val rec = TrackingStateHolder.status.value as? TrackingStatus.Recording ?: return
            if (rec.isPaused) return
            val last = rec.lastFixAt ?: rec.startedAt
            if (System.currentTimeMillis() - last < STALE_FOR_REFRESH_MS) return
            runCatching {
                context.startService(Intent(context, TrackingService::class.java).setAction(ACTION_REFRESH_GPS))
            }
        }

        /** Older than this when the app is opened, and the fix is refreshed. */
        private const val STALE_FOR_REFRESH_MS = 20_000L

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
