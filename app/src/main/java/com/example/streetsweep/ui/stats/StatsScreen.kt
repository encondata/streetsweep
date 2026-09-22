@file:OptIn(ExperimentalMaterial3Api::class)

package com.example.streetsweep.ui.stats

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.example.streetsweep.AppContainer
import com.example.streetsweep.data.AreaWithStats
import com.example.streetsweep.data.db.SessionTotalsRow
import com.example.streetsweep.data.db.WeeklyDrivingRow
import com.example.streetsweep.domain.Geo
import com.example.streetsweep.domain.Pace
import com.example.streetsweep.ui.common.Format
import com.example.streetsweep.ui.common.containerViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlin.math.roundToInt

private const val WEEK_MS = Pace.WEEK_MS

/** An area with how fast it is being finished. */
data class AreaPace(
    val area: AreaWithStats,
    /** Metres of new street credited to it per week lately, or null when there is nothing to go on. */
    val metersPerWeek: Double?,
) {
    /** Weeks left at the recent rate, or null when it is not moving. */
    val weeksLeft: Double?
        get() = Pace.weeksRemaining(
            (area.stats.metersTotal - area.stats.metersDriven).coerceAtLeast(0.0),
            metersPerWeek,
        )
}

@OptIn(ExperimentalCoroutinesApi::class)
class StatsViewModel(private val container: AppContainer) : ViewModel() {

    val totals: StateFlow<SessionTotalsRow?> = container.trackRepository.observeTotals()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    val weekly: StateFlow<List<WeeklyDrivingRow>> = container.trackRepository.observeWeeklyDriving()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /** Each area with the pace of the last few weeks, for the "done by" estimate. */
    val paces: StateFlow<List<AreaPace>> = container.coverageRepository.observeAreasWithStats()
        .flatMapLatest { areas ->
            if (areas.isEmpty()) {
                flowOf(emptyList())
            } else {
                combine(
                    areas.map { a ->
                        container.coverageRepository.observeWeeklyAreaProgress(a.area.id).map { rows ->
                            AreaPace(a, Pace.recentRate(rows.map { it.week to (it.meters ?: 0.0) }))
                        }
                    },
                ) { it.toList() }
            }
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

}

@Composable
fun StatsScreen(
    onBack: () -> Unit,
    viewModel: StatsViewModel = containerViewModel { c, _ -> StatsViewModel(c) },
) {
    val totals by viewModel.totals.collectAsStateWithLifecycle()
    val weekly by viewModel.weekly.collectAsStateWithLifecycle()
    val paces by viewModel.paces.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Progress") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        },
    ) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp)) {
            item {
                totals?.let { t ->
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp)) {
                            Text("All time", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                            Text(
                                "${t.drives} drives · ${Geo.formatDistance(t.meters ?: 0.0)}",
                                style = MaterialTheme.typography.headlineSmall,
                                fontWeight = FontWeight.Bold,
                            )
                            Text(
                                "${Format.duration(t.durationMs ?: 0L)} behind the wheel · " +
                                    "${Geo.formatDistance(t.newMeters ?: 0.0)} of streets covered for the first time",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
            }

            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp)) {
                        Text("Miles per week", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                        Spacer(Modifier.height(8.dp))
                        WeeklyBars(weekly)
                    }
                }
                Spacer(Modifier.height(12.dp))
            }

            if (paces.isNotEmpty()) {
                item {
                    Text(
                        "Areas",
                        Modifier.padding(start = 4.dp, bottom = 6.dp),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
                items(paces, key = { it.area.area.id }) { pace ->
                    AreaProgressCard(pace)
                    Spacer(Modifier.height(8.dp))
                }
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }
}

@Composable
private fun AreaProgressCard(pace: AreaPace) {
    val a = pace.area
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(a.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(
                        "${a.stats.done} of ${a.stats.total} streets · ${Geo.formatDistance(a.stats.metersDriven)} of ${Geo.formatDistance(a.stats.metersTotal)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text("${a.stats.percent}%", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            }
            LinearProgressIndicator(
                progress = { (a.stats.percent / 100f).coerceIn(0f, 1f) },
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            )
            Spacer(Modifier.height(6.dp))
            Text(
                pacePhrase(pace),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

private fun pacePhrase(pace: AreaPace): String {
    if (pace.area.stats.percent >= 100) return "Finished."
    val rate = pace.metersPerWeek
    if (rate == null || rate <= 1.0) return "No progress here in the last month."
    val weeks = pace.weeksLeft ?: return "No progress here in the last month."
    val perWeek = Geo.formatDistance(rate)
    return when {
        weeks <= 1.0 -> "About $perWeek a week lately — roughly a week to go."
        weeks <= 104 -> "About $perWeek a week lately — roughly ${weeks.roundToInt()} weeks to go."
        else -> "About $perWeek a week lately — a long way to go at that rate."
    }
}

/** Last sixteen weeks of driving as plain bars; the newest is on the right. */
@Composable
private fun WeeklyBars(rows: List<WeeklyDrivingRow>) {
    val thisWeek = System.currentTimeMillis() / WEEK_MS
    val span = 16
    val byWeek = rows.associate { it.week to (it.meters ?: 0.0) }
    val series = (0 until span).map { i -> byWeek[thisWeek - (span - 1 - i)] ?: 0.0 }
    val peak = series.maxOrNull() ?: 0.0
    val barColor = MaterialTheme.colorScheme.primary
    val emptyColor = MaterialTheme.colorScheme.surfaceVariant

    if (peak <= 0.0) {
        Text(
            "Nothing recorded in the last four months.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        return
    }
    Canvas(Modifier.fillMaxWidth().height(96.dp)) {
        val gap = size.width / span * 0.25f
        val barWidth = (size.width / span) - gap
        series.forEachIndexed { i, meters ->
            val h = ((meters / peak) * size.height).toFloat().coerceAtLeast(2f)
            val x = i * (barWidth + gap)
            drawRect(
                color = if (meters > 0) barColor else emptyColor,
                topLeft = Offset(x, size.height - h),
                size = Size(barWidth, h),
            )
        }
    }
    Spacer(Modifier.height(4.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text("16 weeks ago", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            "peak ${Geo.formatDistance(peak)}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text("this week", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    @Suppress("UNUSED_EXPRESSION") Color.Transparent
}
