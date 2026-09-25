@file:OptIn(ExperimentalMaterial3Api::class)

package com.example.streetsweep.ui.settings

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material.icons.filled.CloudDownload
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.LaunchedEffect
import com.example.streetsweep.data.backup.BackupFiles
import com.example.streetsweep.ui.common.Format
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bluetooth
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.Restore
import androidx.compose.material.icons.filled.Save
import androidx.compose.material.icons.filled.DirectionsCar
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.runtime.DisposableEffect
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.example.streetsweep.tracking.CarAppHealth
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import com.example.streetsweep.ui.auth.SignInScreen
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.streetsweep.data.prefs.TrackingSettings
import com.example.streetsweep.domain.Geo
import com.example.streetsweep.domain.PointFilter
import com.example.streetsweep.domain.TrackingMode
import com.example.streetsweep.tracking.Permissions
import com.example.streetsweep.tracking.TrackingService
import com.example.streetsweep.tracking.auto.BluetoothDevices
import com.example.streetsweep.ui.common.containerViewModel
import kotlin.math.roundToInt

private data class PermissionState(
    val location: Boolean,
    val background: Boolean,
    val notifications: Boolean,
    val bluetooth: Boolean,
    val activity: Boolean,
)

private fun readPermissions(context: android.content.Context) = PermissionState(
    location = Permissions.hasLocation(context),
    background = Permissions.hasBackgroundLocation(context),
    notifications = Permissions.hasNotifications(context),
    bluetooth = Permissions.hasBluetoothConnect(context),
    activity = com.example.streetsweep.tracking.auto.VehicleActivityTrigger.hasPermission(context),
)

@Composable
fun SettingsScreen(viewModel: SettingsViewModel = containerViewModel { c, ctx -> SettingsViewModel(c, ctx) }) {
    val context = LocalContext.current
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    var perms by remember { mutableStateOf(readPermissions(context)) }
    LifecycleResumeEffect(Unit) {
        perms = readPermissions(context)
        onPauseOrDispose { }
    }
    val refresh = { perms = readPermissions(context) }
    val multiLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { refresh() }
    val singleLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { refresh() }
    var showPicker by remember { mutableStateOf(false) }
    val message by viewModel.message.collectAsStateWithLifecycle()
    val busy by viewModel.busy.collectAsStateWithLifecycle()
    val restartNeeded by viewModel.restartNeeded.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(message) { message?.let { snackbar.showSnackbar(it); viewModel.clearMessage() } }

    val backupLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(BackupFiles.DATABASE_MIME)) { uri ->
        uri?.let(viewModel::backupTo)
    }
    val restoreLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let(viewModel::restoreFrom)
    }
    val gpxLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(BackupFiles.GPX_MIME)) { uri ->
        uri?.let(viewModel::exportGpx)
    }
    val geoJsonLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(BackupFiles.GEOJSON_MIME)) { uri ->
        uri?.let(viewModel::exportGeoJson)
    }
    val folderLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        uri?.let(viewModel::chooseBackupFolder)
    }
    val areaImportLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let(viewModel::importAreas)
    }
    var confirmRestore by remember { mutableStateOf(false) }

    val requestBluetooth = {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) singleLauncher.launch(Manifest.permission.BLUETOOTH_CONNECT)
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text("Settings") }) },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState()),
        ) {
            SectionHeader("Tracking mode")
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
                TrackingMode.entries.forEachIndexed { index, mode ->
                    SegmentedButton(
                        selected = settings.mode == mode,
                        onClick = { viewModel.setMode(mode) },
                        shape = SegmentedButtonDefaults.itemShape(index, TrackingMode.entries.size),
                    ) { Text(if (mode == TrackingMode.MANUAL) "Manual" else "Automatic") }
                }
            }
            Text(
                if (settings.mode == TrackingMode.MANUAL) {
                    "Start and stop recording yourself from the map screen or the notification."
                } else {
                    "Recording starts when your car connects and stops ${TrackingService.STOP_GRACE_MS / 1000}s after it disconnects. " +
                        "You can still start and stop manually."
                },
                Modifier.padding(16.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            SectionHeader("GPS interval")
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
                TrackingSettings.GPS_INTERVAL_CHOICES.forEachIndexed { index, secs ->
                    SegmentedButton(
                        selected = settings.gpsIntervalSeconds == secs,
                        onClick = { viewModel.setGpsInterval(secs) },
                        shape = SegmentedButtonDefaults.itemShape(index, TrackingSettings.GPS_INTERVAL_CHOICES.size),
                    ) { Text("${secs}s") }
                }
            }
            Text(
                "How often a fix is asked for while recording. It is not how often one is kept: the " +
                    "${PointFilter.MIN_SPACING_FEET.toInt()} ft spacing rule still throws away anything closer than that, " +
                    "so a short interval costs battery rather than storage. At 5 seconds a car at residential speed " +
                    "moves about 180 ft between fixes, which is further than a cul-de-sac is wide, and the matcher has " +
                    "nothing to go on inside one. 2 seconds is enough to get round one. Changes take effect " +
                    "immediately, even mid-drive.",
                Modifier.padding(16.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            SectionHeader("Stop after sitting still")
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
                TrackingSettings.IDLE_STOP_CHOICES.forEachIndexed { index, minutes ->
                    SegmentedButton(
                        selected = settings.autoStopIdleMinutes == minutes,
                        onClick = { viewModel.setAutoStopIdleMinutes(minutes) },
                        shape = SegmentedButtonDefaults.itemShape(index, TrackingSettings.IDLE_STOP_CHOICES.size),
                    ) { Text(if (minutes == 0) "Never" else "${minutes}m") }
                }
            }
            Text(
                "Ends a drive that has not moved for this long, so a session you forgot about stops " +
                    "draining the battery. Idle time never reaches the track either way.",
                Modifier.padding(16.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            SectionHeader("Automatic triggers")
            val autoEnabled = settings.mode == TrackingMode.AUTOMATIC
            ListItem(
                modifier = Modifier.clickable(enabled = autoEnabled) {
                    if (Permissions.hasBluetoothConnect(context)) {
                        viewModel.loadDevices(); showPicker = true
                    } else {
                        requestBluetooth()
                    }
                },
                leadingContent = { Icon(Icons.Default.Bluetooth, contentDescription = null) },
                headlineContent = { Text("Car Bluetooth device") },
                supportingContent = {
                    Text(
                        settings.bluetoothTriggerName
                            ?: if (autoEnabled) "Tap to choose a paired device" else "Switch to Automatic to enable",
                    )
                },
                trailingContent = {
                    if (settings.bluetoothTriggerAddress != null) {
                        TextButton(onClick = { viewModel.selectBluetoothDevice(null) }) { Text("Clear") }
                    }
                },
            )
            ListItem(
                leadingContent = { Icon(Icons.Default.DirectionsCar, contentDescription = null) },
                headlineContent = { Text("Android Auto") },
                supportingContent = {
                    Text("Start when the phone connects to Android Auto. Wired connections may need one tap on a notification.")
                },
                trailingContent = {
                    Switch(
                        checked = settings.androidAutoTriggerEnabled,
                        onCheckedChange = viewModel::setAndroidAuto,
                        enabled = autoEnabled,
                    )
                },
            )
            CarScreenHealth()

            ListItem(
                leadingContent = { Icon(Icons.Default.DirectionsCar, contentDescription = null) },
                headlineContent = { Text("In a vehicle (Google activity)") },
                supportingContent = {
                    Text("Fallback for cars with no Bluetooth pairing or Android Auto. Reacts a minute or so later than the others.")
                },
                trailingContent = {
                    Switch(
                        checked = settings.inVehicleTriggerEnabled,
                        onCheckedChange = viewModel::setInVehicle,
                        enabled = autoEnabled,
                    )
                },
            )

            SectionHeader("Map")
            ListItem(
                headlineContent = { Text("Colour driven streets by age") },
                supportingContent = { Text("Recent drives stay teal and older ones fade, so you can see what needs sweeping again") },
                trailingContent = { Switch(checked = settings.colourByRecency, onCheckedChange = viewModel::setColourByRecency) },
            )

            SectionHeader("Backup and export")
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(horizontal = 16.dp))
            ListItem(
                modifier = Modifier.clickable { backupLauncher.launch(BackupFiles.database()) },
                leadingContent = { Icon(Icons.Default.Save, contentDescription = null) },
                headlineContent = { Text("Back up now") },
                supportingContent = { Text("Writes the whole database: drives, areas, exclusions and marked spots") },
            )
            ListItem(
                modifier = Modifier.clickable { confirmRestore = true },
                leadingContent = { Icon(Icons.Default.Restore, contentDescription = null) },
                headlineContent = { Text("Restore from a backup") },
                supportingContent = { Text("Replaces everything currently on this phone") },
            )
            ListItem(
                modifier = Modifier.clickable { folderLauncher.launch(null) },
                leadingContent = { Icon(Icons.Default.Folder, contentDescription = null) },
                headlineContent = { Text("Automatic backup folder") },
                supportingContent = {
                    Text(
                        settings.backupFolderUri?.let { "Chosen. Pick again to change it." }
                            ?: "Not set. Choose a folder, ideally one that syncs to Drive.",
                    )
                },
            )
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
                TrackingSettings.BACKUP_DAY_CHOICES.forEachIndexed { index, days ->
                    SegmentedButton(
                        selected = settings.backupEveryDays == days,
                        onClick = { viewModel.setBackupEveryDays(days) },
                        shape = SegmentedButtonDefaults.itemShape(index, TrackingSettings.BACKUP_DAY_CHOICES.size),
                        enabled = days == 0 || settings.backupFolderUri != null,
                    ) { Text(if (days == 0) "Off" else if (days == 1) "Daily" else "Weekly") }
                }
            }
            Text(
                if (settings.lastBackupAt > 0) "Last automatic backup ${Format.dateTime(settings.lastBackupAt)}. The eight most recent are kept."
                else "No automatic backup written yet. The eight most recent are kept.",
                Modifier.padding(16.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            ListItem(
                modifier = Modifier.clickable { gpxLauncher.launch(BackupFiles.gpx()) },
                headlineContent = { Text("Export drives as GPX") },
                supportingContent = { Text("Every recorded track, plus marked spots as waypoints") },
            )
            ListItem(
                modifier = Modifier.clickable { geoJsonLauncher.launch(BackupFiles.geoJson()) },
                headlineContent = { Text("Export coverage as GeoJSON") },
                supportingContent = { Text("Area outlines and every driven street segment") },
            )
            ListItem(
                modifier = Modifier.clickable { areaImportLauncher.launch(arrayOf("*/*")) },
                leadingContent = { Icon(Icons.Default.Layers, contentDescription = null) },
                headlineContent = { Text("Import areas from GeoJSON") },
                supportingContent = {
                    Text("Outlines drawn on a computer with tools/area-builder.html, or any polygon file")
                },
            )

            SectionHeader("Area builder server")
            UrlField(label = "Server address", value = settings.portalUrl.orEmpty(), onCommit = viewModel::setPortalUrl)
            // Signing in replaces pasting a token by hand: the server issues this phone one
            // of its own, so a drive can be attributed to the person who made it.
            if (settings.portalToken.isNullOrBlank()) {
                // Only reachable by someone who chose to go without an account: signing
                // in is the gate in front of the app, so this puts the gate back.
                ListItem(
                    modifier = Modifier.clickable { viewModel.signInAgain() },
                    leadingContent = { Icon(Icons.Default.AccountCircle, contentDescription = null) },
                    headlineContent = { Text("Sign in") },
                    supportingContent = { Text("With the email and password an administrator gave you") },
                )
            } else {
                ListItem(
                    leadingContent = { Icon(Icons.Default.AccountCircle, contentDescription = null) },
                    headlineContent = {
                        Text(settings.portalUserName ?: settings.portalUserEmail ?: "Signed in")
                    },
                    supportingContent = {
                        Text(
                            when {
                                settings.portalUserName != null && settings.portalUserEmail != null ->
                                    settings.portalUserEmail!!
                                // A token typed in by hand, from before accounts existed.
                                else -> "Signed in with a token"
                            },
                        )
                    },
                    trailingContent = {
                        TextButton(onClick = viewModel::signOutOfPortal) { Text("Sign out") }
                    },
                )
            }
            // These were three lines of green text in a row — "Test", "Get areas", "Send
            // coverage" — and read as labels rather than things to press. Syncing is the one
            // most people want, so it is the filled button; it sends coverage and then takes
            // the web's areas back down, which is everything "Get areas" did and more.
            val serverReady = !settings.portalUrl.isNullOrBlank()
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Button(
                    onClick = { viewModel.pushToPortal(false) },
                    enabled = serverReady,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(Icons.Default.Sync, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text("Sync now")
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = viewModel::pullAreasFromPortal,
                        enabled = serverReady,
                        modifier = Modifier.weight(1f),
                    ) {
                        Icon(Icons.Default.CloudDownload, contentDescription = null)
                        Spacer(Modifier.width(6.dp))
                        Text("Download areas")
                    }
                    OutlinedButton(
                        onClick = viewModel::testPortal,
                        enabled = serverReady,
                    ) { Text("Test") }
                }
            }
            if (settings.portalUrl != TrackingSettings.DEFAULT_PORTAL_URL) {
                ListItem(
                    modifier = Modifier.clickable { viewModel.useHostedPortal() },
                    headlineContent = { Text("Use the hosted server") },
                    supportingContent = { Text(TrackingSettings.DEFAULT_PORTAL_URL) },
                )
            }
            ListItem(
                headlineContent = { Text("Send after every drive") },
                supportingContent = { Text("Pushes the streets you covered as soon as there is a network") },
                trailingContent = {
                    Switch(
                        checked = settings.autoPushEnabled,
                        onCheckedChange = viewModel::setAutoPush,
                        enabled = !settings.portalUrl.isNullOrBlank(),
                    )
                },
            )
            ListItem(
                modifier = Modifier.clickable(enabled = !settings.portalUrl.isNullOrBlank()) { viewModel.pushToPortal(true) },
                headlineContent = { Text("Send everything again") },
                supportingContent = { Text("Clears what the server holds and re-sends every segment. Use after restoring a backup.") },
            )
            Text(
                if (settings.lastPortalPushAt > 0) "Last synced ${Format.dateTime(settings.lastPortalPushAt)}."
                else "Nothing sent yet. Give the server's address, then sign in.",
                Modifier.padding(16.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            SectionHeader("Permissions")
            PermissionRow(
                title = "Precise location",
                granted = perms.location,
                detail = "Required to record any drive",
            ) { multiLauncher.launch(Permissions.LOCATION) }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                PermissionRow(
                    title = "Location \"Allow all the time\"",
                    granted = perms.background,
                    detail = "Needed for automatic mode to record while the app is closed",
                    enabled = perms.location,
                ) { singleLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION) }
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                PermissionRow(
                    title = "Notifications",
                    granted = perms.notifications,
                    detail = "Shows recording status and tap-to-start prompts",
                ) { singleLauncher.launch(Manifest.permission.POST_NOTIFICATIONS) }
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                PermissionRow(
                    title = "Nearby devices (Bluetooth)",
                    granted = perms.bluetooth,
                    detail = "Lets the app see which paired device is your car",
                ) { requestBluetooth() }
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                PermissionRow(
                    title = "Physical activity",
                    granted = perms.activity,
                    detail = "Only needed for the \"in a vehicle\" trigger",
                ) { singleLauncher.launch(Manifest.permission.ACTIVITY_RECOGNITION) }
            }
            TextButton(
                onClick = { context.startActivity(Permissions.appSettingsIntent(context)) },
                modifier = Modifier.padding(horizontal = 8.dp),
            ) { Text("Open app settings") }

            SectionHeader("OpenStreetMap services")
            ListItem(
                headlineContent = { Text("Match drives to streets") },
                supportingContent = { Text("Snaps each drive to OpenStreetMap roads (Valhalla) so streets count as covered") },
                trailingContent = { Switch(checked = settings.snapToRoadsEnabled, onCheckedChange = viewModel::setSnapToRoads) },
            )
            UrlField(label = "Valhalla server", value = settings.valhallaUrl, onCommit = viewModel::setValhallaUrl)
            UrlField(label = "Overpass server", value = settings.overpassUrl, onCommit = viewModel::setOverpassUrl)
            Text(
                "Defaults are free community servers (fair use). Point these at your own instances if they are slow or down.",
                Modifier.padding(horizontal = 16.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            SectionHeader("How recording works")
            Text(
                "A GPS fix is requested every ${settings.gpsIntervalSeconds} seconds. A fix is stored only " +
                    "when it is at least ${PointFilter.MIN_SPACING_FEET.toInt()} ft from the previous stored point, so " +
                    "waiting at a light adds nothing. Fixes with accuracy worse than " +
                    "${Geo.metersToFeet(PointFilter.MAX_ACCURACY_METERS.toDouble()).roundToInt()} ft are ignored.",
                Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(24.dp))
        }
    }

    if (confirmRestore) {
        AlertDialog(
            onDismissRequest = { confirmRestore = false },
            title = { Text("Restore from a backup?") },
            text = {
                Text(
                    "Everything on this phone — drives, areas, exclusions and marked spots — is replaced by " +
                        "whatever is in the file you pick. Back up first if you are not sure.",
                )
            },
            confirmButton = {
                TextButton(onClick = { confirmRestore = false; restoreLauncher.launch(arrayOf("*/*")) }) { Text("Choose a file") }
            },
            dismissButton = { TextButton(onClick = { confirmRestore = false }) { Text("Cancel") } },
        )
    }

    if (restartNeeded) {
        AlertDialog(
            onDismissRequest = { },
            title = { Text("Restored") },
            text = { Text("StreetSweep needs to restart to open the restored data.") },
            confirmButton = { TextButton(onClick = viewModel::restartApp) { Text("Restart now") } },
        )
    }

    if (showPicker) {
        BluetoothDevicePicker(
            viewModel = viewModel,
            selectedAddress = settings.bluetoothTriggerAddress,
            onSelect = { viewModel.selectBluetoothDevice(it); showPicker = false },
            onDismiss = { showPicker = false },
        )
    }

}

@Composable
private fun UrlField(label: String, value: String, onCommit: (String) -> Unit) {
    var text by remember(value) { mutableStateOf(value) }
    OutlinedTextField(
        value = text,
        onValueChange = { text = it },
        label = { Text(label) },
        singleLine = true,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        trailingIcon = {
            if (text.trim() != value) TextButton(onClick = { onCommit(text) }) { Text("Save") }
        },
    )
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text,
        Modifier.padding(start = 16.dp, top = 20.dp, end = 16.dp, bottom = 4.dp),
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
    )
}

@Composable
private fun PermissionRow(
    title: String,
    granted: Boolean,
    detail: String,
    enabled: Boolean = true,
    onRequest: () -> Unit,
) {
    ListItem(
        leadingContent = {
            Icon(
                if (granted) Icons.Default.Check else Icons.Default.Warning,
                contentDescription = null,
                tint = if (granted) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
            )
        },
        headlineContent = { Text(title) },
        supportingContent = { Text(detail) },
        trailingContent = {
            if (!granted) TextButton(onClick = onRequest, enabled = enabled) { Text("Grant") }
        },
    )
}

@Composable
private fun BluetoothDevicePicker(
    viewModel: SettingsViewModel,
    selectedAddress: String?,
    onSelect: (BluetoothDevices.Info) -> Unit,
    onDismiss: () -> Unit,
) {
    val devices by viewModel.devices.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { if (devices == null) viewModel.loadDevices() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Choose your car") },
        text = {
            val list = devices
            when {
                list == null -> Box(Modifier.fillMaxWidth().height(80.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
                list.isEmpty() -> Text("No paired Bluetooth devices found. Pair your car in the phone's Bluetooth settings first.")
                else -> LazyColumn(Modifier.heightIn(max = 360.dp)) {
                    items(list, key = { it.address }) { d ->
                        ListItem(
                            modifier = Modifier.clickable { onSelect(d) },
                            headlineContent = { Text(d.name) },
                            supportingContent = {
                                Text(d.address + if (d.connected) " · connected now" else "")
                            },
                            trailingContent = {
                                if (d.address.equals(selectedAddress, ignoreCase = true)) {
                                    Icon(Icons.Default.Check, contentDescription = "Selected")
                                }
                            },
                        )
                        HorizontalDivider()
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

/**
 * What this phone can see about the car screen.
 *
 * A sideloaded car app is easy to lose: Android Auto only lists apps it has been told to
 * trust, and its own updates reset that. From the car there is no way to tell a broken app
 * from an unlisted one, so this says which it is.
 */
@Composable
private fun CarScreenHealth() {
    val context = LocalContext.current
    var health by remember { mutableStateOf<CarAppHealth?>(null) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // Read it again on the way back from Android Auto's settings, so a change there shows.
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) health = CarAppHealth.read(context)
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }

    val h = health ?: return
    ListItem(
        leadingContent = {
            Icon(
                if (h.looksRight) Icons.Default.CheckCircle else Icons.Default.ErrorOutline,
                contentDescription = null,
                tint = if (h.looksRight) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
            )
        },
        headlineContent = { Text("Car screen") },
        supportingContent = {
            Text(
                buildString {
                    when {
                        !h.androidAutoInstalled -> append("Android Auto is not installed on this phone.")
                        !h.serviceDeclared || !h.serviceEnabled ->
                            append("This phone cannot see StreetSweep's car screen. Reinstall the app.")
                        else -> append("StreetSweep's car screen is installed and switched on.")
                    }
                    h.androidAutoVersion?.let { append(" Android Auto $it.") }
                    if (h.looksRight) {
                        append(
                            " If it is still missing from the car, Android Auto has stopped trusting it: " +
                                "turn on Developer settings \u2192 Unknown sources, then reconnect. " +
                                "The car's app list is only rebuilt when a car connects.",
                        )
                    }
                },
            )
        },
        trailingContent = {
            if (h.androidAutoInstalled) {
                TextButton(onClick = { CarAppHealth.openAndroidAuto(context) }) { Text("Open") }
            }
        },
    )
}
