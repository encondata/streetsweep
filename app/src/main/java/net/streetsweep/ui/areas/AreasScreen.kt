@file:OptIn(ExperimentalMaterial3Api::class)

package net.streetsweep.ui.areas

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
import androidx.compose.material.icons.filled.FormatListBulleted
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Place
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarResult
import androidx.compose.runtime.rememberCoroutineScope
import net.streetsweep.data.db.CoverageArea
import net.streetsweep.data.server.SyncWorker
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
import net.streetsweep.ui.common.ProgressRing
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
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarHost
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
import net.streetsweep.AppContainer
import net.streetsweep.data.AreaWithStats
import net.streetsweep.data.osm.StreetDownloadWorker
import net.streetsweep.domain.Geo
import net.streetsweep.ui.common.containerViewModel
import net.streetsweep.ui.map.MapFocus
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class AreasViewModel(private val container: AppContainer, private val context: Context) : ViewModel() {
    val areas: StateFlow<List<AreaWithStats>> = container.coverageRepository.observeAreasWithStats()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /** Areas put out of sight on this phone, offered back at the foot of the list. */
    val hidden: StateFlow<List<CoverageArea>> = container.coverageRepository.observeHiddenAreas()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())


    /** Where areas are drawn, to say so when there are none. */
    val webAddress: StateFlow<String> = container.settings.settings
        .map { it.serverUrl.removePrefix("https://").removePrefix("http://").trimEnd('/') }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), "")

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message
    fun clearMessage() { _message.value = null }

    /** Areas are the web's to delete; the phone can only put one out of sight. */
    fun hide(id: Long) = viewModelScope.launch { container.coverageRepository.setHidden(id, true) }
    fun show(id: Long) = viewModelScope.launch { container.coverageRepository.setHidden(id, false) }

    fun redownload(id: Long) = viewModelScope.launch {
        container.coverageRepository.setProgress(id, 0, 0, error = null, loadedAt = null)
        StreetDownloadWorker.enqueue(context, id)
    }

    /**
     * Syncs now rather than at the next drive or launch: drives and marks go up, and the
     * web's areas, figures and deletions come down, with streets for any new area after.
     */
    fun syncNow() {
        SyncWorker.enqueue(context)
        _message.value = "Syncing with the server…"
    }
}

/** An area and its children, in display order with an indent level. */
private data class Node(val item: AreaWithStats, val depth: Int)

private fun tree(areas: List<AreaWithStats>): List<Node> {
    val byParent = areas.groupBy { it.area.parentId }
    val ids = areas.map { it.area.id }.toSet()
    val out = ArrayList<Node>()
    fun walk(parent: Long?, depth: Int) {
        byParent[parent].orEmpty().sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })
            .forEach { n -> out += Node(n, depth); walk(n.area.id, depth + 1) }
    }
    walk(null, 0)
    // Children whose parent was deleted still show, at the top level.
    areas.filter { it.area.parentId != null && it.area.parentId !in ids }
        .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })
        .forEach { out += Node(it, 0) }
    return out
}

@Composable
fun AreasScreen(
    onShowOnMap: () -> Unit,
    onOpenStreets: (Long) -> Unit = {},
    viewModel: AreasViewModel = containerViewModel { c, ctx -> AreasViewModel(c, ctx) },
) {
    val areas by viewModel.areas.collectAsStateWithLifecycle()
    val hidden by viewModel.hidden.collectAsStateWithLifecycle()
    val webAddress by viewModel.webAddress.collectAsStateWithLifecycle()
    val message by viewModel.message.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    LaunchedEffect(message) { message?.let { snackbar.showSnackbar(it); viewModel.clearMessage() } }
    // Hiding is one tap and easily undone, so it asks nothing first.
    fun hideWithUndo(a: AreaWithStats) {
        viewModel.hide(a.area.id)
        scope.launch {
            val r = snackbar.showSnackbar("${a.name} hidden on this phone", actionLabel = "Undo", duration = SnackbarDuration.Short)
            if (r == SnackbarResult.ActionPerformed) viewModel.show(a.area.id)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Areas") },
                actions = {
                    TextButton(onClick = viewModel::syncNow) {
                        Icon(Icons.Default.Sync, contentDescription = null)
                        Spacer(Modifier.width(6.dp))
                        Text("Sync")
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        if (areas.isEmpty() && hidden.isEmpty()) {
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
                Text(
                    "Areas are drawn on the web" + (if (webAddress.isNotEmpty()) " at $webAddress" else "") +
                        ", and arrive here, with their streets, at the next sync.",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
                Spacer(Modifier.height(18.dp))
                Button(onClick = viewModel::syncNow) {
                    Icon(Icons.Default.Sync, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text("Sync now")
                }
            }
            return@Scaffold
        }
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp)) {
            item {
                Text(
                    "Street maps © OpenStreetMap contributors",
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
                                        text = { Text("Re-download streets") },
                                        leadingIcon = { Icon(Icons.Default.Refresh, contentDescription = null) },
                                        onClick = { menu = false; viewModel.redownload(a.area.id) },
                                    )
                                    DropdownMenuItem(
                                        text = { Text("Hide on this phone") },
                                        leadingIcon = { Icon(Icons.Default.VisibilityOff, contentDescription = null) },
                                        onClick = { menu = false; hideWithUndo(a) },
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
            if (hidden.isNotEmpty()) {
                item {
                    Text(
                        "Hidden on this phone",
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
                    )
                    Text(
                        "Off the map, the lists and guidance here. Still on the web; deleting an area is done there.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(bottom = 8.dp),
                    )
                }
                items(hidden, key = { "hidden-" + it.id }) { h ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(h.name, style = MaterialTheme.typography.bodyLarge)
                            Text(
                                net.streetsweep.domain.AreaLevel.entries.getOrNull(h.level)?.label.orEmpty(),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        TextButton(onClick = { viewModel.show(h.id) }) {
                            Icon(Icons.Default.Visibility, contentDescription = null)
                            Spacer(Modifier.width(6.dp))
                            Text("Show")
                        }
                    }
                }
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }
}
