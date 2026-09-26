@file:OptIn(ExperimentalMaterial3Api::class)

package com.example.streetsweep.ui.areas

import android.content.Context
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
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.FormatListBulleted
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Place
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.ui.draw.clip
import com.example.streetsweep.ui.common.ProgressRing
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.MutableStateFlow
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarHost
import androidx.compose.material.icons.filled.CloudDownload
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.example.streetsweep.AppContainer
import com.example.streetsweep.data.AreaWithStats
import com.example.streetsweep.data.osm.StreetDownloadWorker
import com.example.streetsweep.domain.Geo
import com.example.streetsweep.ui.common.containerViewModel
import com.example.streetsweep.ui.map.MapFocus
import com.example.streetsweep.ui.map.RedrawRequest
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class AreasViewModel(private val container: AppContainer, private val context: Context) : ViewModel() {
    val areas: StateFlow<List<AreaWithStats>> = container.coverageRepository.observeAreasWithStats()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    val wayCount: StateFlow<Int> = container.coverageRepository.observeWayCount()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0)

    fun delete(id: Long) = viewModelScope.launch { container.coverageRepository.deleteArea(id) }

    fun redownload(id: Long) = viewModelScope.launch {
        container.coverageRepository.setProgress(id, 0, 0, error = null, loadedAt = null)
        StreetDownloadWorker.enqueue(context, id)
    }

    /** Whether there is a server to download from at all. */
    val canDownload: StateFlow<Boolean> = container.settings.settings
        .map { !it.portalUrl.isNullOrBlank() && !it.portalToken.isNullOrBlank() }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), false)

    private val _downloading = MutableStateFlow(false)
    val downloading: StateFlow<Boolean> = _downloading

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message
    fun clearMessage() { _message.value = null }

    /**
     * Brings this phone's areas into line with the portal's. Lives here as well as in
     * Settings because the Areas screen is where anyone looking for "download my areas"
     * goes first; buried halfway down Settings as plain text, it went unfound.
     */
    fun downloadFromWeb() = viewModelScope.launch {
        if (_downloading.value) return@launch
        _downloading.value = true
        _message.value = try {
            val pull = container.portalSync.pullAreas()
            // Anything whose streets never finished goes back on the queue too. A second tap
            // here is how a download that failed part-way gets finished: its outline already
            // matches the web, so the pull alone would say there was nothing to do.
            val unfinished = container.coverageRepository.unfinishedAreaIds()
            val queued = StreetDownloadWorker.enqueueAll(context, pull.needStreets + unfinished)
            val retrying = (unfinished - pull.needStreets.toSet()).size
            listOfNotNull(
                pull.summary(),
                if (retrying > 0) "retrying streets for $retrying unfinished ${if (retrying == 1) "area" else "areas"}" else null,
            ).joinToString(" · ").ifEmpty { null }
                ?.let { it + if (queued > 0) " — downloading one area at a time" else "" }
                ?: "Already up to date — this phone has every area on the server"
        } catch (e: Exception) {
            "Could not download areas: ${e.message ?: "no answer from the server"}"
        } finally {
            _downloading.value = false
        }
    }
}

/** An area and its children, in display order with an indent level. */
private data class Node(val item: AreaWithStats, val depth: Int)

private fun tree(areas: List<AreaWithStats>): List<Node> {
    val byParent = areas.groupBy { it.area.parentId }
    val ids = areas.map { it.area.id }.toSet()
    val out = ArrayList<Node>()
    fun walk(parent: Long?, depth: Int) {
        byParent[parent].orEmpty().sortedWith(compareByDescending<AreaWithStats> { it.area.level }.thenBy { it.name.lowercase() })
            .forEach { n -> out += Node(n, depth); walk(n.area.id, depth + 1) }
    }
    walk(null, 0)
    // Children whose parent was deleted still show, at the top level.
    areas.filter { it.area.parentId != null && it.area.parentId !in ids }.forEach { out += Node(it, 0) }
    return out
}

@Composable
fun AreasScreen(
    onShowOnMap: () -> Unit,
    onOpenStreets: (Long) -> Unit = {},
    viewModel: AreasViewModel = containerViewModel { c, ctx -> AreasViewModel(c, ctx) },
) {
    val areas by viewModel.areas.collectAsStateWithLifecycle()
    val wayCount by viewModel.wayCount.collectAsStateWithLifecycle()
    val canDownload by viewModel.canDownload.collectAsStateWithLifecycle()
    val downloading by viewModel.downloading.collectAsStateWithLifecycle()
    val message by viewModel.message.collectAsStateWithLifecycle()
    var pendingDelete by remember { mutableStateOf<AreaWithStats?>(null) }
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(message) { message?.let { snackbar.showSnackbar(it); viewModel.clearMessage() } }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Areas") },
                actions = {
                    if (canDownload) {
                        if (downloading) {
                            CircularProgressIndicator(
                                strokeWidth = 2.dp,
                                modifier = Modifier.padding(end = 16.dp).size(22.dp),
                            )
                        } else {
                            TextButton(onClick = viewModel::downloadFromWeb) {
                                Icon(Icons.Default.CloudDownload, contentDescription = null)
                                Spacer(Modifier.width(6.dp))
                                Text("Download from web")
                            }
                        }
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        if (areas.isEmpty()) {
            Column(
                Modifier.fillMaxSize().padding(padding).padding(32.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    "No areas yet.",
                    style = MaterialTheme.typography.titleMedium,
                )
                Spacer(Modifier.height(10.dp))
                if (canDownload) {
                    Text(
                        "Download the ones drawn on the web, or frame one on the Map tab and tap \"Add area\".",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    )
                    Spacer(Modifier.height(18.dp))
                    Button(onClick = viewModel::downloadFromWeb, enabled = !downloading) {
                        Icon(Icons.Default.CloudDownload, contentDescription = null)
                        Spacer(Modifier.width(8.dp))
                        Text(if (downloading) "Downloading…" else "Download areas from the web")
                    }
                } else {
                    Text(
                        "On the Map tab, frame a neighbourhood, city or metro and tap \"Add area\". " +
                            "Nest neighbourhoods inside cities and cities inside a metro to see progress at every level.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    )
                }
            }
            return@Scaffold
        }
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp)) {
            item {
                Text(
                    "$wayCount streets loaded from OpenStreetMap",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(bottom = 8.dp),
                )
            }
            items(tree(areas), key = { it.item.area.id }) { node ->
                val a = node.item
                Card(
                    Modifier
                        .fillMaxWidth()
                        .padding(start = (node.depth * 20).dp, bottom = 8.dp)
                        .clickable { MapFocus.request(a.bounds); onShowOnMap() },
                ) {
                    Column(Modifier.padding(12.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(a.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                                Text(a.level.label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                            }
                            if (!a.area.isDownloading) {
                                ProgressRing(
                                    fraction = (a.stats.percent / 100f).coerceIn(0f, 1f),
                                    diameter = 52.dp,
                                    thickness = 6.dp,
                                ) {
                                    Text(
                                        "${a.stats.percent}%",
                                        style = MaterialTheme.typography.labelLarge,
                                        fontWeight = FontWeight.Bold,
                                    )
                                }
                                Spacer(Modifier.width(4.dp))
                            }
                            var menu by remember { mutableStateOf(false) }
                            Box {
                                IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, contentDescription = "Area actions") }
                                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                    DropdownMenuItem(
                                        text = { Text("Street list") },
                                        leadingIcon = { Icon(Icons.Default.FormatListBulleted, contentDescription = null) },
                                        onClick = { menu = false; onOpenStreets(a.area.id) },
                                    )
                                    DropdownMenuItem(
                                        text = { Text("Show on map") },
                                        leadingIcon = { Icon(Icons.Default.Place, contentDescription = null) },
                                        onClick = { menu = false; MapFocus.request(a.bounds); onShowOnMap() },
                                    )
                                    DropdownMenuItem(
                                        text = { Text("Edit outline") },
                                        leadingIcon = { Icon(Icons.Default.Edit, contentDescription = null) },
                                        onClick = { menu = false; MapFocus.requestRedraw(RedrawRequest(a.area.id, a.name, a.vertices)); onShowOnMap() },
                                    )
                                    DropdownMenuItem(
                                        text = { Text("Re-download streets") },
                                        leadingIcon = { Icon(Icons.Default.Refresh, contentDescription = null) },
                                        onClick = { menu = false; viewModel.redownload(a.area.id) },
                                    )
                                    DropdownMenuItem(
                                        text = { Text("Delete area") },
                                        leadingIcon = { Icon(Icons.Default.Delete, contentDescription = null) },
                                        onClick = { menu = false; pendingDelete = a },
                                    )
                                }
                            }
                        }
                        when {
                            a.area.lastError != null -> Text(
                                "Download failed: ${a.area.lastError}. Tap refresh to retry.",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error,
                            )
                            a.area.isDownloading -> {
                                Text("Downloading streets ${a.area.chunksDone}/${a.area.chunksTotal}", style = MaterialTheme.typography.bodySmall)
                                LinearProgressIndicator(
                                    progress = { if (a.area.chunksTotal == 0) 0f else a.area.chunksDone.toFloat() / a.area.chunksTotal },
                                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                                )
                            }
                            else -> {
                                Text(
                                    "${a.stats.done} of ${a.stats.total} streets done" +
                                        (if (a.stats.partial > 0) " · ${a.stats.partial} partly" else "") +
                                        (if (a.stats.excluded > 0) " · ${a.stats.excluded} excluded" else "") +
                                        " · ${Geo.formatDistance(a.stats.metersDriven)} of ${Geo.formatDistance(a.stats.metersTotal)}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                // Where the figures come from, and for a big area, how much of
                                // its street map is on this phone.
                                val provenance = buildList {
                                    if (a.stats.fromServer && a.stats.updatedAt > 0) {
                                        add("From the web, " + java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT)
                                            .format(java.util.Date(a.stats.updatedAt)))
                                    }
                                    if (a.area.onDemand) {
                                        add("streets load as you drive (${a.area.chunksDone} of ${a.area.chunksTotal} map cells here)")
                                    }
                                }
                                if (provenance.isNotEmpty()) {
                                    Text(
                                        provenance.joinToString(" · ").replaceFirstChar { it.uppercase() },
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                // What is left, and a way straight to it. The street list
                                // was previously only in the overflow menu.
                                Spacer(Modifier.height(10.dp))
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .clip(RoundedCornerShape(10.dp))
                                        .clickable { onOpenStreets(a.area.id) }
                                        .padding(vertical = 8.dp, horizontal = 10.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(
                                        if (a.stats.total == 0) "No streets counted yet" else
                                        if (a.stats.remaining == 0) "Every street driven" else
                                            "${a.stats.remaining} street${if (a.stats.remaining == 1) "" else "s"} remaining",
                                        style = MaterialTheme.typography.bodyMedium,
                                        fontWeight = FontWeight.SemiBold,
                                        modifier = Modifier.weight(1f),
                                    )
                                    Icon(
                                        Icons.AutoMirrored.Filled.KeyboardArrowRight,
                                        contentDescription = "Street list",
                                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    }
                }
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }

    pendingDelete?.let { a ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("Delete ${a.name}?") },
            text = { Text("Removes the area and its progress figure. Downloaded streets and your drives are kept; nested areas move up a level.") },
            confirmButton = { TextButton(onClick = { viewModel.delete(a.area.id); pendingDelete = null }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { pendingDelete = null }) { Text("Cancel") } },
        )
    }
}
