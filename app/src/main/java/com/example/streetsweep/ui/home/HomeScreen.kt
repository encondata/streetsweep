package com.example.streetsweep.ui.home

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.NearMe
import androidx.compose.material.icons.filled.NearMeDisabled
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Route
import androidx.compose.material3.HorizontalDivider
import com.example.streetsweep.data.RouteState
import com.example.streetsweep.ui.common.ProgressRing
import com.example.streetsweep.domain.GuidanceMode
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.Navigation
import androidx.compose.material.icons.filled.MyLocation
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Snackbar
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.streetsweep.data.AreaWithStats
import com.example.streetsweep.data.NearestStreet
import com.example.streetsweep.data.StreetStatus
import com.example.streetsweep.domain.AreaLevel
import com.example.streetsweep.domain.ExclusionReason
import com.example.streetsweep.ui.map.MapFocus
import com.example.streetsweep.domain.Geo
import com.example.streetsweep.domain.PointFilter
import com.example.streetsweep.domain.TrackingMode
import com.example.streetsweep.tracking.Permissions
import com.example.streetsweep.tracking.TrackingStatus
import com.example.streetsweep.ui.common.Format
import kotlin.math.roundToInt
import com.example.streetsweep.ui.common.containerViewModel
import com.example.streetsweep.ui.map.TrackMap
import com.example.streetsweep.ui.map.TrackMapController
import kotlinx.coroutines.launch

@Composable
fun HomeScreen(
    onOpenSettings: () -> Unit,
    viewModel: HomeViewModel = containerViewModel { c, ctx -> HomeViewModel(c, ctx) },
) {
    val context = LocalContext.current
    val status by viewModel.status.collectAsStateWithLifecycle()
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val carConnected by viewModel.carConnected.collectAsStateWithLifecycle()
    val btConnected by viewModel.bluetoothTriggerConnected.collectAsStateWithLifecycle()
    val layers by viewModel.layers.collectAsStateWithLifecycle()
    val focused by viewModel.focusedArea.collectAsStateWithLifecycle()
    val areas by viewModel.areas.collectAsStateWithLifecycle()
    val message by viewModel.message.collectAsStateWithLifecycle()
    val drawing by viewModel.drawing.collectAsStateWithLifecycle()
    val drawMode by viewModel.drawMode.collectAsStateWithLifecycle()
    val selectedStreet by viewModel.selectedStreet.collectAsStateWithLifecycle()
    val nearest by viewModel.nearest.collectAsStateWithLifecycle()
    val routeTarget by viewModel.routeTarget.collectAsStateWithLifecycle()
    val route by viewModel.route.collectAsStateWithLifecycle()
    val planning by viewModel.planning.collectAsStateWithLifecycle()
    val pendingExclude by viewModel.pendingExcludeCount.collectAsStateWithLifecycle()
    val lastPoiId by viewModel.lastPoiId.collectAsStateWithLifecycle()
    val selectedVertex by viewModel.selectedVertex.collectAsStateWithLifecycle()
    var noteFor by remember { mutableStateOf<Long?>(null) }
    val draft by viewModel.draft.collectAsStateWithLifecycle()

    var hasLocation by remember { mutableStateOf(Permissions.hasLocation(context)) }
    LifecycleResumeEffect(Unit) {
        hasLocation = Permissions.hasLocation(context)
        viewModel.refreshBluetoothTriggerState()
        viewModel.refreshPosition()
        onPauseOrDispose { }
    }
    val locationLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        hasLocation = Permissions.hasLocation(context)
    }

    val scope = rememberCoroutineScope()
    val mapController = remember { TrackMapController() }
    var follow by rememberSaveable { mutableStateOf(true) }
    var centeredOnce by rememberSaveable { mutableStateOf(false) }
    var confirmArea by remember { mutableStateOf(false) }

    /**
     * How close in to sit. 15 shows a neighbourhood, which is what you want when picking
     * an area; it is too far out to read the street you are about to turn into. While
     * recording, start in close enough for the names to be legible. Following never
     * changes the zoom after that, so a pinch still wins.
     */
    val drivingZoom = 17.0
    val restingZoom = 15.0

    // Another screen asked us to show, or redraw, an area.
    val pendingFocus by MapFocus.pending.collectAsStateWithLifecycle()
    LaunchedEffect(pendingFocus) {
        MapFocus.consume()?.let { follow = false; centeredOnce = true; mapController.fitBounds(it) }
        MapFocus.consumeRedraw()?.let { viewModel.startDrawing(redraw = it) }
    }

    LaunchedEffect(hasLocation) {
        if (hasLocation && !centeredOnce) {
            viewModel.lastKnownLocation()?.let { here ->
                mapController.animateTo(here, if (status is TrackingStatus.Recording) drivingZoom else restingZoom)
                centeredOnce = true
            }
        }
    }

    // Starting a drive pulls the map in to driving distance, once. Pinching back out
    // afterwards sticks, because following leaves the zoom alone.
    val recording = status is TrackingStatus.Recording
    LaunchedEffect(recording) {
        if (recording && follow) {
            (layers.activeRaw.lastOrNull() ?: viewModel.lastKnownLocation())
                ?.let { mapController.animateTo(it, drivingZoom) }
        }
    }
    val lastPoint = layers.activeRaw.lastOrNull()
    LaunchedEffect(lastPoint, follow) {
        if (follow && lastPoint != null) mapController.animateTo(lastPoint)
    }

    Box(Modifier.fillMaxSize()) {
        TrackMap(
            modifier = Modifier.fillMaxSize(),
            layers = layers,
            mapController = mapController,
            onUserGesture = { follow = false },
            onViewportChanged = viewModel::onViewport,
            onMapTap = viewModel::onMapTap,
            draftEditor = viewModel.draftEditor,
        )

        // Status card sits flush under the status bar so the map keeps the most room.
        Column(
            Modifier
                .align(Alignment.TopCenter)
                .statusBarsPadding()
                .padding(start = 8.dp, end = 8.dp, top = 2.dp)
                .fillMaxWidth(),
        ) {
            StatusCard(
                status = status,
                mode = settings.mode,
                bluetoothTriggerName = settings.bluetoothTriggerName,
                bluetoothTriggerConnected = btConnected,
                androidAutoEnabled = settings.androidAutoTriggerEnabled,
                carConnected = carConnected,
                focused = focused,
                hasAreas = areas.isNotEmpty(),
                onAddArea = { viewModel.startDrawing(DrawMode.AREA) },
                onExcludeShape = { viewModel.startDrawing(DrawMode.EXCLUDE) },
            )
            if (drawing) {
                Spacer(Modifier.height(8.dp))
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
                    Text(
                        when {
                            viewModel.redrawing != null -> "Editing ${viewModel.redrawing?.name}. "
                            drawMode == DrawMode.EXCLUDE -> "Outline the gated or private area. Streets inside it stop counting. "
                            else -> "Outline the area (3+ points). "
                        } +
                            "Tap the map to add a point · drag a point to move it · touch a small circle between points to add one there · " +
                            "tap a point, then Delete, to remove it.",
                        Modifier.padding(12.dp),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onErrorContainer,
                    )
                }
            }
            if (!drawing) {
                nearest?.let { n ->
                    Spacer(Modifier.height(6.dp))
                    val headline = routeTarget?.let { t ->
                        "On route · ${t.position} of ${t.total} · " +
                            "${Geo.formatDistance(n.distanceMeters)} ${n.compass}"
                    } ?: "Nearest undriven · ${Geo.formatDistance(n.distanceMeters)} ${n.compass}"
                    GuidanceCard(n, headline) { follow = false; mapController.animateTo(n.point, 16.5) }
                }
            }
        }

        if (hasLocation && !drawing) {
            androidx.compose.material3.FloatingActionButton(
                onClick = viewModel::markPoi,
                containerColor = MaterialTheme.colorScheme.errorContainer,
                contentColor = MaterialTheme.colorScheme.onErrorContainer,
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(end = 16.dp, bottom = 160.dp),
            ) { Icon(Icons.Default.Flag, contentDescription = "Mark this spot") }
        }

        if (!drawing) {
            GuidanceButton(
                mode = settings.guidanceMode,
                planning = planning,
                route = route,
                focusedAreaName = focused?.name,
                onMode = viewModel::setGuidanceMode,
                onReplan = viewModel::planRoute,
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(end = 16.dp, bottom = 224.dp),
            )
        }

        androidx.compose.material3.FloatingActionButton(
            onClick = {
                // Neutral, so the guidance button above is the only green one and reads as
                // the thing that is switched on.
                follow = true
                scope.launch {
                    (lastPoint ?: viewModel.lastKnownLocation())?.let {
                        mapController.animateTo(it, if (recording) drivingZoom else restingZoom)
                    }
                }
            },
            containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
            contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(end = 16.dp, bottom = 96.dp),
        ) { Icon(Icons.Default.MyLocation, contentDescription = "Center on me") }

        Row(
            Modifier
                .align(Alignment.BottomCenter)
                .padding(16.dp)
                .fillMaxWidth(),
            horizontalArrangement = Arrangement.Center,
        ) {
            when {
                drawing -> DrawControls(
                    points = draft.size,
                    redrawing = viewModel.redrawing != null,
                    excluding = drawMode == DrawMode.EXCLUDE,
                    hasSelection = selectedVertex != null,
                    onDeletePoint = viewModel::deleteSelectedPoint,
                    onUndo = viewModel::undoDraftPoint,
                    onUseView = viewModel::useViewAsDraft,
                    onCancel = viewModel::cancelDrawing,
                    onDone = {
                        when {
                            drawMode == DrawMode.EXCLUDE -> viewModel.prepareExcludeFromDraft()
                            viewModel.redrawing != null -> viewModel.finishRedraw()
                            else -> confirmArea = true
                        }
                    },
                )
                !hasLocation -> Button(onClick = { locationLauncher.launch(Permissions.LOCATION) }) {
                    Text("Allow precise location to record")
                }
                status is TrackingStatus.Recording -> {
                    val paused = (status as TrackingStatus.Recording).isPaused
                    // Pause keeps the drive open, so a stop at the shops does not become a
                    // second drive in the list.
                    Button(
                        onClick = if (paused) viewModel::resumeTracking else viewModel::pauseTracking,
                        colors = if (paused) {
                            ButtonDefaults.buttonColors()
                        } else {
                            ButtonDefaults.buttonColors(
                                containerColor = MaterialTheme.colorScheme.tertiaryContainer,
                                contentColor = MaterialTheme.colorScheme.onTertiaryContainer,
                            )
                        },
                    ) {
                        Icon(
                            if (paused) Icons.Default.PlayArrow else Icons.Default.Pause,
                            contentDescription = null,
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(if (paused) "Resume" else "Pause")
                    }
                    Spacer(Modifier.width(10.dp))
                    Button(
                        onClick = viewModel::stopTracking,
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                    ) {
                        Icon(Icons.Default.Stop, contentDescription = null)
                        Spacer(Modifier.width(8.dp))
                        Text("Stop")
                    }
                }
                else -> Button(onClick = viewModel::startManual) {
                    Icon(Icons.Default.PlayArrow, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text("Start recording")
                }
            }
        }

        message?.let { msg ->
            val poiId = lastPoiId
            Snackbar(
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 80.dp, start = 16.dp, end = 16.dp),
                action = {
                    if (msg.startsWith("Marked") && poiId != null) {
                        TextButton(onClick = { noteFor = poiId; viewModel.clearMessage() }) { Text("Add note") }
                    } else {
                        TextButton(onClick = viewModel::clearMessage) { Text("OK") }
                    }
                },
            ) { Text(msg) }
        }
    }

    if (hasLocation && settings.mode == TrackingMode.AUTOMATIC && !Permissions.hasBackgroundLocation(context)) {
        Box(Modifier.fillMaxSize().padding(bottom = 72.dp), contentAlignment = Alignment.BottomCenter) {
            TextButton(onClick = onOpenSettings) { Text("Automatic mode needs \"Allow all the time\" location → Settings") }
        }
    }

    noteFor?.let { id ->
        var note by remember(id) { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { noteFor = null },
            title = { Text("Note for this spot") },
            text = {
                androidx.compose.material3.OutlinedTextField(
                    value = note, onValueChange = { note = it }, singleLine = false, minLines = 2,
                    placeholder = { Text("e.g. pothole, missing sign, house for sale") },
                    modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = { TextButton(onClick = { viewModel.setPoiNote(id, note); noteFor = null }) { Text("Save") } },
            dismissButton = { TextButton(onClick = { noteFor = null }) { Text("Skip") } },
        )
    }

    selectedStreet?.let { street ->
        StreetActionsDialog(
            street = street,
            onExclude = { reason -> viewModel.setSelectedExcluded(true, reason) },
            onInclude = { viewModel.setSelectedExcluded(false) },
            onDismiss = viewModel::clearSelectedStreet,
        )
    }

    pendingExclude?.let { count ->
        ExcludeShapeDialog(
            count = count,
            onConfirm = { reason -> viewModel.confirmExcludeFromDraft(reason) },
            onDismiss = viewModel::cancelExclude,
        )
    }

    if (confirmArea) {
        CreateAreaDialog(
            cells = viewModel.cellsForDraft(),
            zoom = viewModel.currentViewport?.zoom ?: 0.0,
            existing = areas,
            onCreate = { name, level, parent -> confirmArea = false; viewModel.createAreaFromDraft(name, level, parent) },
            onDismiss = { confirmArea = false },
        )
    }
}

@Composable
private fun CreateAreaDialog(
    cells: Int,
    zoom: Double,
    existing: List<AreaWithStats>,
    onCreate: (String, AreaLevel, Long?) -> Unit,
    onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var level by remember { mutableStateOf(if (zoom >= 13) AreaLevel.NEIGHBORHOOD else if (zoom >= 10.5) AreaLevel.CITY else AreaLevel.METRO) }
    var parentId by remember { mutableStateOf<Long?>(null) }
    val tooLarge = cells > com.example.streetsweep.data.osm.StreetDownloadWorker.MAX_CELLS
    val parents = existing.filter { it.area.level > level.ordinal }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add coverage area") },
        text = {
            Column {
                Text(
                    "Streets inside your outline are downloaded from OpenStreetMap in $cells map cell${if (cells == 1) "" else "s"}" +
                        (if (cells > 40) " (about ${cells * 3 / 60 + 1} min)" else "") + ".",
                    style = MaterialTheme.typography.bodySmall,
                )
                if (tooLarge) Text("Too large. Zoom in, or add it as several cities.", color = MaterialTheme.colorScheme.error)
                Spacer(Modifier.height(8.dp))
                androidx.compose.material3.OutlinedTextField(
                    value = name, onValueChange = { name = it }, label = { Text("Name") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    AreaLevel.entries.forEach { l ->
                        androidx.compose.material3.FilterChip(
                            selected = level == l,
                            onClick = { level = l; parentId = null },
                            label = { Text(l.label) },
                        )
                    }
                }
                if (parents.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp))
                    Text("Part of", style = MaterialTheme.typography.labelMedium)
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        androidx.compose.material3.FilterChip(selected = parentId == null, onClick = { parentId = null }, label = { Text("None") })
                        parents.take(3).forEach { p ->
                            androidx.compose.material3.FilterChip(
                                selected = parentId == p.area.id,
                                onClick = { parentId = p.area.id },
                                label = { Text(p.name) },
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(enabled = !tooLarge && cells > 0, onClick = { onCreate(name, level, parentId) }) { Text("Add & download") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun GuidanceCard(n: NearestStreet, headline: String, onClick: () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.94f)),
        modifier = Modifier.clickable(onClick = onClick),
    ) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            // The arrow points the true compass bearing; the map is north-up, so it reads directly.
            Icon(
                Icons.Default.Navigation,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onTertiaryContainer,
                modifier = Modifier.size(28.dp).rotate(n.bearingDegrees.toFloat()),
            )
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    headline,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onTertiaryContainer,
                )
                Text(
                    n.street.label,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onTertiaryContainer,
                )
            }
        }
    }
}

@Composable
private fun ReasonChips(selected: ExclusionReason, onSelect: (ExclusionReason) -> Unit) {
    val rows = ExclusionReason.entries.chunked(2)
    Column {
        rows.forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                row.forEach { r ->
                    FilterChip(
                        selected = selected == r,
                        onClick = { onSelect(r) },
                        label = { Text(r.label, style = MaterialTheme.typography.labelSmall) },
                        modifier = Modifier.weight(1f),
                    )
                }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
            Spacer(Modifier.height(4.dp))
        }
    }
}

@Composable
private fun StreetActionsDialog(
    street: StreetStatus,
    onExclude: (ExclusionReason) -> Unit,
    onInclude: () -> Unit,
    onDismiss: () -> Unit,
) {
    var reason by remember(street.wayId) { mutableStateOf(ExclusionReason.GATED) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(street.label) },
        text = {
            Column {
                Text(
                    "${street.highway.replace('_', ' ')} · ${Geo.formatDistance(street.lengthMeters)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    when {
                        street.excluded -> "Excluded — does not count toward coverage"
                        street.isDone -> "Driven"
                        street.isPartial -> "${(street.fraction * 100).roundToInt()}% driven"
                        else -> "Not driven yet"
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                if (!street.excluded) {
                    Spacer(Modifier.height(12.dp))
                    Text("Exclude because", style = MaterialTheme.typography.labelMedium)
                    Spacer(Modifier.height(4.dp))
                    ReasonChips(reason) { reason = it }
                }
            }
        },
        confirmButton = {
            if (street.excluded) {
                TextButton(onClick = onInclude) { Text("Count it again") }
            } else {
                TextButton(onClick = { onExclude(reason) }) { Text("Exclude") }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

@Composable
private fun ExcludeShapeDialog(count: Int, onConfirm: (ExclusionReason) -> Unit, onDismiss: () -> Unit) {
    var reason by remember { mutableStateOf(ExclusionReason.GATED) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (count == 0) "No streets inside" else "Exclude $count street${if (count == 1) "" else "s"}?") },
        text = {
            Column {
                Text(
                    if (count == 0) {
                        "Nothing inside that outline. Streets are matched by their midpoint, so try a larger shape."
                    } else {
                        "They stay on the map in grey but stop counting toward any area's total. You can put any of them back by tapping it."
                    },
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (count > 0) {
                    Spacer(Modifier.height(12.dp))
                    ReasonChips(reason) { reason = it }
                }
            }
        },
        confirmButton = {
            if (count > 0) TextButton(onClick = { onConfirm(reason) }) { Text("Exclude") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun AddMenuButton(outlined: Boolean, onAddArea: () -> Unit, onExcludeShape: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        if (outlined) {
            OutlinedButton(onClick = { open = true }) { Text("Add area") }
        } else {
            TextButton(onClick = { open = true }) { Text("Add") }
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text("Add coverage area") },
                leadingIcon = { Icon(Icons.Default.Layers, contentDescription = null) },
                onClick = { open = false; onAddArea() },
            )
            DropdownMenuItem(
                text = { Text("Exclude a gated area") },
                leadingIcon = { Icon(Icons.Default.Block, contentDescription = null) },
                onClick = { open = false; onExcludeShape() },
            )
        }
    }
}

@Composable
private fun DrawControls(
    points: Int,
    redrawing: Boolean,
    excluding: Boolean,
    hasSelection: Boolean,
    onDeletePoint: () -> Unit,
    onUndo: () -> Unit,
    onUseView: () -> Unit,
    onCancel: () -> Unit,
    onDone: () -> Unit,
) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.94f))) {
        Row(Modifier.padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = onCancel) { Text("Cancel") }
            if (hasSelection) {
                TextButton(onClick = onDeletePoint, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("Delete") }
            } else {
                TextButton(onClick = onUndo, enabled = points > 0) { Text("Undo") }
            }
            if (!redrawing && !hasSelection) TextButton(onClick = onUseView) { Text("Use view") }
            Button(onClick = onDone, enabled = points >= 3) {
                Text(if (redrawing) "Save" else if (excluding) "Exclude inside" else "Done ($points)")
            }
        }
    }
}

@Composable
private fun StatusCard(
    status: TrackingStatus,
    mode: TrackingMode,
    bluetoothTriggerName: String?,
    bluetoothTriggerConnected: Boolean?,
    androidAutoEnabled: Boolean,
    carConnected: Boolean,
    focused: AreaWithStats?,
    hasAreas: Boolean,
    onAddArea: () -> Unit,
    onExcludeShape: () -> Unit,
) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.94f))) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
            when (status) {
                TrackingStatus.Idle -> {
                    Text("Not recording", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(
                        if (mode == TrackingMode.AUTOMATIC) "Automatic mode: waiting for your car" else "Manual mode",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                is TrackingStatus.Recording -> {
                    Text(
                        if (status.isPaused) {
                            "Paused · ${Geo.formatDistance(status.distanceMeters)}"
                        } else {
                            "Recording · ${Geo.formatDistance(status.distanceMeters)}"
                        },
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = if (status.isPaused) {
                            MaterialTheme.colorScheme.tertiary
                        } else {
                            MaterialTheme.colorScheme.primary
                        },
                    )
                    if (status.isPaused) {
                        Text(
                            "The drive is still open. Resume and it carries on as one drive.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Text(
                        "${status.pointCount} points since ${Format.time(status.startedAt)} · " +
                            "${status.skippedTooClose} fixes skipped (< ${PointFilter.MIN_SPACING_FEET.toInt()} ft)" +
                            (if (status.skippedInaccurate > 0) " · ${status.skippedInaccurate} inaccurate" else ""),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        "Started by ${status.trigger.label}" +
                            (status.lastFixAt?.let { " · last fix ${Format.time(it)}" } ?: " · waiting for GPS"),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    status.stopScheduledAt?.let {
                        Text(
                            "Car disconnected · stopping at ${Format.time(it)} unless it reconnects",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
            }
            if (mode == TrackingMode.AUTOMATIC) {
                Spacer(Modifier.height(4.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (bluetoothTriggerName != null) TriggerChip(label = bluetoothTriggerName, connected = bluetoothTriggerConnected)
                    if (androidAutoEnabled) TriggerChip(label = "Android Auto", connected = carConnected)
                }
            }

            Spacer(Modifier.height(8.dp))
            val a = focused
            when {
                a == null -> Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (hasAreas) "Move the map into one of your areas to see its progress." else "No coverage areas yet.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f),
                    )
                    AddMenuButton(outlined = true, onAddArea = onAddArea, onExcludeShape = onExcludeShape)
                }
                a.area.isDownloading -> Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                    Text("${a.name}: downloading streets ${a.area.chunksDone}/${a.area.chunksTotal}", style = MaterialTheme.typography.bodySmall)
                }
                else -> Row(verticalAlignment = Alignment.CenterVertically) {
                    // The ring carries what is left as well as what is done, which a bare
                    // percentage does not.
                    ProgressRing(
                        fraction = (a.stats.percent / 100f).coerceIn(0f, 1f),
                        diameter = 58.dp,
                        thickness = 7.dp,
                    ) {
                        Text(
                            "${a.stats.percent}%",
                            style = MaterialTheme.typography.labelLarge,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(a.name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        Text(
                            "${a.stats.done} of ${a.stats.total} streets · ${a.level.label}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            "${Geo.formatDistance(a.stats.metersDriven)} of ${Geo.formatDistance(a.stats.metersTotal)}" +
                                (if (a.stats.partial > 0) " · ${a.stats.partial} partly" else "") +
                                (if (a.stats.excluded > 0) " · ${a.stats.excluded} excluded" else "") +
                                (a.area.lastError?.let { " · download failed" } ?: ""),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    AddMenuButton(outlined = false, onAddArea = onAddArea, onExcludeShape = onExcludeShape)
                }
            }
        }
    }
}

@Composable
private fun TriggerChip(label: String, connected: Boolean?) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        val color = when (connected) {
            true -> MaterialTheme.colorScheme.primary
            false -> MaterialTheme.colorScheme.outline
            null -> MaterialTheme.colorScheme.outlineVariant
        }
        Canvas(Modifier.size(8.dp)) { drawCircle(color) }
        Spacer(Modifier.width(6.dp))
        Text(
            "$label · " + when (connected) { true -> "connected"; false -> "not connected"; null -> "unknown" },
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * The guidance control: a button that says what the map is currently pointing you towards,
 * and a menu to change it. Sits with the marker button rather than in Settings, because it
 * is something you change mid-drive.
 */
@Composable
private fun GuidanceButton(
    mode: GuidanceMode,
    planning: Boolean,
    route: RouteState.Planned?,
    focusedAreaName: String?,
    onMode: (GuidanceMode) -> Unit,
    onReplan: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var open by remember { mutableStateOf(false) }
    Box(modifier) {
        androidx.compose.material3.FloatingActionButton(
            onClick = { open = true },
            containerColor = if (mode == GuidanceMode.OFF) {
                MaterialTheme.colorScheme.surfaceContainerHigh
            } else {
                MaterialTheme.colorScheme.primaryContainer
            },
            contentColor = if (mode == GuidanceMode.OFF) {
                MaterialTheme.colorScheme.onSurfaceVariant
            } else {
                MaterialTheme.colorScheme.onPrimaryContainer
            },
        ) {
            if (planning) {
                CircularProgressIndicator(
                    Modifier.size(22.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                )
            } else {
                Icon(
                    when (mode) {
                        GuidanceMode.OFF -> Icons.Default.NearMeDisabled
                        GuidanceMode.NEAREST -> Icons.Default.NearMe
                        GuidanceMode.ROUTE -> Icons.Default.Route
                    },
                    contentDescription = "Guidance",
                )
            }
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            Text(
                "Guidance",
                Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            GuidanceChoice("Off", "The map only records", Icons.Default.NearMeDisabled,
                mode == GuidanceMode.OFF) { onMode(GuidanceMode.OFF); open = false }
            GuidanceChoice("Nearest undriven", "Whichever street owing is closest", Icons.Default.NearMe,
                mode == GuidanceMode.NEAREST) { onMode(GuidanceMode.NEAREST); open = false }
            GuidanceChoice(
                "Drive the whole area",
                focusedAreaName?.let { "Every street in $it, least backtracking" }
                    ?: "Pick an area on the map first",
                Icons.Default.Route,
                mode == GuidanceMode.ROUTE,
                enabled = focusedAreaName != null,
            ) { onMode(GuidanceMode.ROUTE); open = false }

            if (mode == GuidanceMode.ROUTE) {
                HorizontalDivider()
                route?.let { planned ->
                    Text(
                        buildString {
                            append("${planned.route.requiredCount} streets · ")
                            append(Geo.formatDistance(planned.route.totalMeters))
                            append('\n')
                            append(Geo.formatDistance(planned.route.deadheadMeters))
                            append(" of that is backtracking")
                            if (planned.route.unreachable > 0) {
                                append("\n${planned.route.unreachable} could not be reached")
                            }
                            if (planned.route.truncated) append("\nPlanned the nearest part only")
                        },
                        Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                DropdownMenuItem(
                    text = { Text(if (route == null) "Work out a route" else "Work it out again") },
                    leadingIcon = { Icon(Icons.Default.Refresh, contentDescription = null) },
                    enabled = !planning && focusedAreaName != null,
                    onClick = { onReplan(); open = false },
                )
            }
        }
    }
}

@Composable
private fun GuidanceChoice(
    title: String,
    detail: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    selected: Boolean,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    DropdownMenuItem(
        text = {
            Column {
                Text(title, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal)
                Text(
                    detail,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        leadingIcon = { Icon(icon, contentDescription = null) },
        trailingIcon = {
            if (selected) Icon(Icons.Default.Check, contentDescription = "Selected")
        },
        enabled = enabled,
        onClick = onClick,
    )
}
