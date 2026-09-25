@file:OptIn(ExperimentalMaterial3Api::class)

package com.example.streetsweep.ui.streets

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
import com.example.streetsweep.AppContainer
import com.example.streetsweep.data.AreaWithStats
import com.example.streetsweep.data.CoverageRepository
import com.example.streetsweep.data.StreetStatus
import com.example.streetsweep.domain.Bounds
import com.example.streetsweep.domain.ExclusionReason
import com.example.streetsweep.domain.Geo
import com.example.streetsweep.ui.common.containerViewModel
import com.example.streetsweep.ui.map.MapFocus
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

enum class StreetFilter(val label: String) {
    ALL("All"), UNDRIVEN("Undriven"), PARTIAL("Partly"), DONE("Done"), EXCLUDED("Excluded")
}

class StreetsViewModel(private val container: AppContainer, private val areaId: Long) : ViewModel() {

    val area: StateFlow<AreaWithStats?> = container.coverageRepository.observeAreasWithStats()
        .map { list -> list.firstOrNull { it.area.id == areaId } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    val streets: StateFlow<List<StreetStatus>> = container.coverageRepository.observeAreaStreets(areaId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    val limit = CoverageRepository.AREA_STREET_LIMIT

    fun setExcluded(wayId: Long, excluded: Boolean, reason: ExclusionReason = ExclusionReason.GATED) {
        viewModelScope.launch {
            if (excluded) container.coverageRepository.exclude(listOf(wayId), reason)
            else container.coverageRepository.include(listOf(wayId))
        }
    }

    fun setCompleted(wayId: Long, marked: Boolean) {
        viewModelScope.launch { container.coverageRepository.setCompleted(listOf(wayId), marked) }
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

    val shown = remember(all, filter, query) {
        all.asSequence()
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
                    "Showing the first ${viewModel.limit} streets of this area.",
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
                items(shown, key = { it.wayId }) { s ->
                    ListItem(
                        modifier = Modifier.clickable {
                            Bounds.of(s.shape)?.let { MapFocus.request(it) }
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
                                        s.isDone -> "done"
                                        s.isPartial -> "${(s.fraction * 100).roundToInt()}% driven"
                                        else -> "not driven"
                                    },
                            )
                        },
                        trailingContent = {
                          Row {
                            // Finishing a street by hand is for one the GPS only partly
                            // caught; a fully driven one has nothing to mark.
                            if (s.completed) {
                                IconButton(onClick = { viewModel.setCompleted(s.wayId, false) }) {
                                    Icon(Icons.Default.RemoveDone, contentDescription = "Unmark complete")
                                }
                            } else if (s.isPartial) {
                                IconButton(onClick = { viewModel.setCompleted(s.wayId, true) }) {
                                    Icon(Icons.Default.DoneAll, contentDescription = "Mark this street complete")
                                }
                            }
                            IconButton(onClick = { viewModel.setExcluded(s.wayId, !s.excluded) }) {
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
                TextButton(onClick = { viewModel.excludeAll(shown.map { it.wayId }, reason); bulk = false }) { Text("Exclude") }
            },
            dismissButton = { TextButton(onClick = { bulk = false }) { Text("Cancel") } },
        )
    }
}
