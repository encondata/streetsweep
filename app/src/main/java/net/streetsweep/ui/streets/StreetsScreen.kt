@file:OptIn(ExperimentalMaterial3Api::class)

package net.streetsweep.ui.streets

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.RemoveDone
import androidx.compose.material.icons.filled.Undo
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
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
import net.streetsweep.data.CoverageRepository
import net.streetsweep.data.StreetStatus
import net.streetsweep.domain.Bounds
import net.streetsweep.domain.ExclusionReason
import net.streetsweep.domain.Geo
import net.streetsweep.domain.LatLngPoint
import net.streetsweep.ui.common.containerViewModel
import net.streetsweep.ui.map.MapFocus
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

enum class StreetFilter(val label: String) {
    ALL("All"), UNDRIVEN("Undriven"), PARTIAL("Partly"), DONE("Done"), EXCLUDED("Excluded")
}

/**
 * A street as people know it: every piece of it in the area that shares its name (the
 * map cuts streets at each junction). Counted and shown as one, the same way the area's
 * figures and the server count streets; marking or excluding it does every piece.
 */
data class StreetGroup(val key: String, val pieces: List<StreetStatus>) {
    private val counted = pieces.filter { !it.excluded }
    val label: String get() = pieces.first().label
    val highway: String get() = pieces.groupingBy { it.highway }.eachCount().maxBy { it.value }.key
    val lengthMeters: Double get() = pieces.sumOf { it.lengthMeters }
    val excluded: Boolean get() = counted.isEmpty()
    /** Share of its (counted) length driven or marked. */
    val fraction: Double get() {
        val total = counted.sumOf { it.lengthMeters }
        return if (total <= 0) 0.0 else counted.sumOf { it.lengthMeters * it.fraction.coerceAtMost(1.0) } / total
    }
    val isDone: Boolean get() = !excluded && counted.all { it.isDone }
    val isFull: Boolean get() = !excluded && counted.all { it.isFull }
    val completed: Boolean get() = !excluded && counted.all { it.completed }
    val isPartial: Boolean get() = !excluded && !isDone && counted.any { !it.isUndriven }
    val isUndriven: Boolean get() = !excluded && counted.all { it.isUndriven }
    val ids: List<Long> get() = pieces.map { it.wayId }
    val shapes: List<LatLngPoint> get() = pieces.flatMap { it.shape }

    companion object {
        fun of(streets: List<StreetStatus>): List<StreetGroup> =
            streets.groupBy { it.name?.lowercase() ?: "piece ${it.wayId}" }
                .map { (k, v) -> StreetGroup(k, v) }
                .sortedBy { it.label.lowercase() }
    }
}

class StreetsViewModel(private val container: AppContainer, private val areaId: Long) : ViewModel() {

    val area: StateFlow<AreaWithStats?> = container.coverageRepository.observeAreasWithStats()
        .map { list -> list.firstOrNull { it.area.id == areaId } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    val streets: StateFlow<List<StreetStatus>> = container.coverageRepository.observeAreaStreets(areaId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    val limit = CoverageRepository.AREA_STREET_LIMIT

    fun setExcluded(wayIds: List<Long>, excluded: Boolean, reason: ExclusionReason = ExclusionReason.GATED) {
        viewModelScope.launch {
            if (excluded) container.coverageRepository.exclude(wayIds, reason)
            else container.coverageRepository.include(wayIds)
        }
    }

    fun setCompleted(wayIds: List<Long>, marked: Boolean) {
        viewModelScope.launch { container.coverageRepository.setCompleted(wayIds, marked) }
    }

    fun excludeAll(wayIds: List<Long>, reason: ExclusionReason) {
        viewModelScope.launch { container.coverageRepository.exclude(wayIds, reason) }
    }
}

@Composable
fun StreetsScreen(
    areaId: Long,
    onBack: () -> Unit,
    onShowOnMap: () -> Unit,
    viewModel: StreetsViewModel = containerViewModel(key = "streets-$areaId") { c, _ -> StreetsViewModel(c, areaId) },
) {
    val area by viewModel.area.collectAsStateWithLifecycle()
    val all by viewModel.streets.collectAsStateWithLifecycle()
    var filter by remember { mutableStateOf(StreetFilter.UNDRIVEN) }
    var query by remember { mutableStateOf("") }
    var bulk by remember { mutableStateOf(false) }

    val groups = remember(all) { StreetGroup.of(all) }
    val shown = remember(groups, filter, query) {
        groups.asSequence()
            .filter { s ->
                when (filter) {
                    StreetFilter.ALL -> true
                    StreetFilter.UNDRIVEN -> s.isUndriven
                    StreetFilter.PARTIAL -> s.isPartial
                    StreetFilter.DONE -> s.isDone
                    StreetFilter.EXCLUDED -> s.excluded
                }
            }
            .filter { s -> query.isBlank() || s.label.contains(query.trim(), ignoreCase = true) }
            .toList()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(area?.name ?: "Streets") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
                actions = {
                    if (shown.isNotEmpty() && filter != StreetFilter.EXCLUDED) {
                        TextButton(onClick = { bulk = true }) { Text("Exclude shown") }
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            area?.let { a ->
                Text(
                    "${a.stats.done} of ${a.stats.total} done · ${a.stats.percent}%" +
                        (if (a.stats.excluded > 0) " · ${a.stats.excluded} excluded" else ""),
                    Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                StreetFilter.entries.forEach { f ->
                    FilterChip(selected = filter == f, onClick = { filter = f }, label = { Text(f.label) })
                }
            }
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                label = { Text("Search street") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            )
            if (all.size >= viewModel.limit) {
                Text(
                    "This area is too big to list in full here; some of its streets are left out.",
                    Modifier.padding(horizontal = 16.dp),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            if (shown.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(
                        if (all.isEmpty()) "No streets loaded for this area yet." else "Nothing matches that filter.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(32.dp),
                    )
                }
                return@Column
            }
            LazyColumn(Modifier.fillMaxSize()) {
                items(shown, key = { it.key }) { s ->
                    ListItem(
                        modifier = Modifier.clickable {
                            Bounds.of(s.shapes)?.let { MapFocus.request(it) }
                            onShowOnMap()
                        },
                        headlineContent = {
                            Text(
                                s.label,
                                fontWeight = if (s.excluded) FontWeight.Normal else FontWeight.Medium,
                                color = if (s.excluded) MaterialTheme.colorScheme.outline else MaterialTheme.colorScheme.onSurface,
                            )
                        },
                        supportingContent = {
                            Text(
                                "${s.highway.replace('_', ' ')} · ${Geo.formatDistance(s.lengthMeters)} · " +
                                    when {
                                        s.excluded -> "excluded"
                                        s.completed -> "marked complete"
                                        s.isFull -> "done"
                                        s.isDone -> "${(s.fraction * 100).roundToInt()}% · counts as done"
                                        s.isPartial -> "${(s.fraction * 100).roundToInt()}% driven"
                                        else -> "not driven"
                                    },
                            )
                        },
                        trailingContent = {
                          Row {
                            // Finishing a street by hand is for one the GPS missed some or all
                            // of; a driven one has nothing to mark, an excluded one no total.
                            if (s.completed) {
                                IconButton(onClick = { viewModel.setCompleted(s.pieces.filter { it.completed }.map { it.wayId }, false) }) {
                                    Icon(Icons.Default.RemoveDone, contentDescription = "Unmark complete")
                                }
                            } else if (!s.isFull && !s.excluded) {
                                IconButton(onClick = { viewModel.setCompleted(s.pieces.filter { !it.isFull && !it.excluded }.map { it.wayId }, true) }) {
                                    Icon(Icons.Default.DoneAll, contentDescription = "Mark this street complete")
                                }
                            }
                            IconButton(onClick = {
                                viewModel.setExcluded(if (s.excluded) s.ids else s.pieces.filter { !it.excluded }.map { it.wayId }, !s.excluded)
                            }) {
                                if (s.excluded) {
                                    Icon(Icons.Default.Undo, contentDescription = "Count this street again")
                                } else {
                                    Icon(Icons.Default.Block, contentDescription = "Exclude this street")
                                }
                            }
                          }
                        },
                    )
                    HorizontalDivider()
                }
                item { Spacer(Modifier.height(24.dp)) }
            }
        }
    }

    if (bulk) {
        var reason by remember { mutableStateOf(ExclusionReason.GATED) }
        AlertDialog(
            onDismissRequest = { bulk = false },
            title = { Text("Exclude ${shown.size} street${if (shown.size == 1) "" else "s"}?") },
            text = {
                Column {
                    Text(
                        "Every street currently listed stops counting toward coverage. " +
                            "Narrow the list with the search box first if you only meant some of them.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Spacer(Modifier.height(12.dp))
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        ExclusionReason.entries.forEach { r ->
                            FilterChip(
                                selected = reason == r,
                                onClick = { reason = r },
                                label = { Text(r.label, style = MaterialTheme.typography.labelSmall) },
                            )
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { viewModel.excludeAll(shown.flatMap { it.ids }, reason); bulk = false }) { Text("Exclude") }
            },
            dismissButton = { TextButton(onClick = { bulk = false }) { Text("Cancel") } },
        )
    }
}
