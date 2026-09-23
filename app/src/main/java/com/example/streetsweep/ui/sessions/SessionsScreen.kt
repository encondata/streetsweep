@file:OptIn(ExperimentalMaterial3Api::class)

package com.example.streetsweep.ui.sessions

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.InsertChart
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.streetsweep.data.db.TrackSession
import com.example.streetsweep.domain.Geo
import com.example.streetsweep.domain.TriggerSource
import com.example.streetsweep.ui.common.Format
import com.example.streetsweep.ui.common.containerViewModel
import com.example.streetsweep.ui.map.MapLayers
import com.example.streetsweep.ui.map.TrackMap
import com.example.streetsweep.ui.map.TrackMapController

@Composable
fun SessionsScreen(
    onOpenSession: (Long) -> Unit,
    onBack: (() -> Unit)? = null,
    onOpenPlaces: () -> Unit = {},
    viewModel: SessionsViewModel = containerViewModel { c, _ -> SessionsViewModel(c) },
) {
    val sessions by viewModel.sessions.collectAsStateWithLifecycle()
    val totals by viewModel.totals.collectAsStateWithLifecycle()
    val activeId by viewModel.activeSessionId.collectAsStateWithLifecycle()
    var pendingDelete by remember { mutableStateOf<TrackSession?>(null) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Drives") },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                        }
                    }
                },
                actions = {
                    IconButton(onClick = onOpenPlaces) { Icon(Icons.Default.Flag, contentDescription = "Marked spots") }
                },
            )
        },
    ) { padding ->
        if (sessions.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Text(
                    "No drives recorded yet.\nStart one from the map, or set up automatic mode in Settings.",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(32.dp),
                )
            }
            return@Scaffold
        }
        LazyColumn(Modifier.fillMaxSize().padding(padding)) {
            totals?.let { t ->
                item {
                    Column(Modifier.fillMaxWidth().padding(16.dp)) {
                        Text("All time", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                        Text(
                            "${t.drives} drives · ${Geo.formatDistance(t.meters ?: 0.0)} · ${Format.duration(t.durationMs ?: 0L)}",
                            style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            "${Geo.formatDistance(t.newMeters ?: 0.0)} of streets covered for the first time · ${t.newSegments ?: 0} segments",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    HorizontalDivider()
                }
            }
            items(sessions, key = { it.id }) { s ->
                val isActive = s.id == activeId
                ListItem(
                    modifier = Modifier.clickable { onOpenSession(s.id) },
                    headlineContent = {
                        Text(
                            Format.dateTime(s.startedAt) + if (isActive) "  · recording" else "",
                            fontWeight = if (isActive) FontWeight.SemiBold else FontWeight.Normal,
                            color = if (isActive) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                        )
                    },
                    supportingContent = { Text(summaryLine(s)) },
                    trailingContent = {
                        if (!isActive) {
                            IconButton(onClick = { pendingDelete = s }) {
                                Icon(Icons.Default.Delete, contentDescription = "Delete drive")
                            }
                        }
                    },
                )
                HorizontalDivider()
            }
        }
    }

    pendingDelete?.let { s ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("Delete this drive?") },
            text = { Text("${Format.dateTime(s.startedAt)} · ${summaryLine(s)}\n\nThis cannot be undone.") },
            confirmButton = {
                TextButton(onClick = { viewModel.delete(s.id); pendingDelete = null }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { pendingDelete = null }) { Text("Cancel") } },
        )
    }
}

private fun summaryLine(s: TrackSession): String {
    val end = s.endedAt ?: System.currentTimeMillis()
    val snapped = if (s.snappedRawCount >= s.pointCount && s.pointCount >= 2) " · matched" else ""
    val fresh = if (s.newSegments > 0) " · +${Geo.formatDistance(s.newMeters)} new" else ""
    return "${Geo.formatDistance(s.distanceMeters)} · ${s.pointCount} points · ${Format.duration(end - s.startedAt)} · " +
        TriggerSource.fromName(s.trigger).label + snapped + fresh
}

@Composable
fun SessionDetailScreen(
    sessionId: Long,
    onBack: () -> Unit,
    viewModel: SessionDetailViewModel = containerViewModel(key = "session-$sessionId") { c, _ ->
        SessionDetailViewModel(c, sessionId)
    },
) {
    val session by viewModel.session.collectAsStateWithLifecycle()
    val raw by viewModel.raw.collectAsStateWithLifecycle()
    val snapped by viewModel.snapped.collectAsStateWithLifecycle()
    val snapping by viewModel.snapping.collectAsStateWithLifecycle()
    val message by viewModel.message.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }

    LaunchedEffect(message) {
        message?.let { snackbar.showSnackbar(it); viewModel.clearMessage() }
    }

    val mapController = remember { TrackMapController() }
    var fitted by remember { mutableStateOf(false) }
    LaunchedEffect(raw) {
        if (!fitted && raw.isNotEmpty()) { mapController.fitTo(raw); fitted = true }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(session?.let { Format.dateTime(it.startedAt) } ?: "Drive") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            TrackMap(
                modifier = Modifier.weight(1f).fillMaxWidth(),
                layers = MapLayers(activeRaw = raw, activeMatched = snapped),
                mapController = mapController,
            )
            session?.let { s ->
                Column(Modifier.padding(16.dp)) {
                    Text(summaryLine(s), style = MaterialTheme.typography.bodyMedium)
                    if (s.newSegments > 0) {
                        Text(
                            "This drive covered ${Geo.formatDistance(s.newMeters)} of streets for the first time (${s.newSegments} segments)",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                    Text(
                        if (snapped.size >= 2) "Road-matched track: ${snapped.size} points" else "Not yet matched to roads",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Button(onClick = viewModel::snapNow, enabled = !snapping && raw.size >= 2) {
                            Text(if (s.snappedRawCount < s.pointCount) "Match to roads" else "Re-check matching")
                        }
                        if (snapping) {
                            Spacer(Modifier.width(12.dp))
                            CircularProgressIndicator(Modifier.width(20.dp).height(20.dp), strokeWidth = 2.dp)
                        }
                    }
                }
            }
        }
    }
}
