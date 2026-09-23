@file:OptIn(ExperimentalMaterial3Api::class)

package com.example.streetsweep.ui.stats

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.filled.Adjust
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Straighten
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.TextButton
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.draw.clip
import com.example.streetsweep.domain.AreaLevel
import com.example.streetsweep.ui.common.LegendLine
import com.example.streetsweep.ui.common.RingWithLegend
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

/** The whole picture in one card: what is done, what is left, and how much ground it took. */
data class Overview(
    val drivenStreets: Int,
    val unvisitedStreets: Int,
    val areasCompleted: Int,
    val areasInProgress: Int,
    val metersDriven: Double,
    val metersTotal: Double,
    val lifetimeMeters: Double,
) {
    val totalStreets: Int get() = drivenStreets + unvisitedStreets
    val fraction: Float get() = if (metersTotal <= 0) 0f else (metersDriven / metersTotal).toFloat()

    companion object {
        val EMPTY = Overview(0, 0, 0, 0, 0.0, 0.0, 0.0)
    }
}

/** An area with how fast it is being finished. */
data class AreaPace(
    val area: AreaWithStats,
    /** Metres of new street credited to it per week lately, or null when there is nothing to go on. */
    val metersPerWeek: Double?,
    /** The last week any new street was credited to it, for ordering recent work. */
    val lastProgressWeek: Long? = null,
) {
    val isComplete: Boolean get() = area.stats.total > 0 && area.stats.remaining == 0
    val isStarted: Boolean get() = area.stats.metersDriven > 0
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
                            AreaPace(
                                area = a,
                                metersPerWeek = Pace.recentRate(rows.map { it.week to (it.meters ?: 0.0) }),
                                lastProgressWeek = rows.filter { (it.meters ?: 0.0) > 0 }.maxOfOrNull { it.week },
                            )
                        }
                    },
                ) { it.toList() }
            }
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /** Every area added up, plus the lifetime distance from the drive log. */
    val overview: StateFlow<Overview> = combine(paces, totals) { list, t ->
        Overview(
            drivenStreets = list.sumOf { it.area.stats.done },
            unvisitedStreets = list.sumOf { it.area.stats.remaining },
            areasCompleted = list.count { it.isComplete },
            areasInProgress = list.count { it.isStarted && !it.isComplete },
            metersDriven = list.sumOf { it.area.stats.metersDriven },
            metersTotal = list.sumOf { it.area.stats.metersTotal },
            lifetimeMeters = t?.meters ?: 0.0,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), Overview.EMPTY)

    /** Areas that have seen work, most recent first. */
    val recent: StateFlow<List<AreaPace>> = paces
        .map { list ->
            list.filter { it.isStarted }
                .sortedWith(compareByDescending<AreaPace> { it.lastProgressWeek ?: 0L }.thenByDescending { it.area.stats.percent })
                .take(6)
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
}

private enum class ProgressTab(val label: String) { Overview("Overview"), Areas("Areas"), Cities("Cities") }

@Composable
fun StatsScreen(
    onBack: (() -> Unit)? = null,
    onOpenDrives: () -> Unit = {},
    viewModel: StatsViewModel = containerViewModel { c, _ -> StatsViewModel(c) },
) {
    val overview by viewModel.overview.collectAsStateWithLifecycle()
    val recent by viewModel.recent.collectAsStateWithLifecycle()
    val paces by viewModel.paces.collectAsStateWithLifecycle()
    val weekly by viewModel.weekly.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableStateOf(ProgressTab.Overview) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("My Progress") },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                        }
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    ProgressTab.entries.forEachIndexed { index, entry ->
                        SegmentedButton(
                            selected = tab == entry,
                            onClick = { tab = entry },
                            shape = SegmentedButtonDefaults.itemShape(index, ProgressTab.entries.size),
                        ) { Text(entry.label) }
                    }
                }
            }

            when (tab) {
                ProgressTab.Overview -> {
                    item { TotalProgressCard(overview) }
                    item { AreasTally(overview) }
                    item { DistanceCard(overview) }
                    if (weekly.isNotEmpty()) {
                        item {
                            Card {
                                Column(Modifier.padding(16.dp)) {
                                    Text(
                                        "Miles per week",
                                        style = MaterialTheme.typography.labelMedium,
                                        color = MaterialTheme.colorScheme.primary,
                                    )
                                    Spacer(Modifier.height(12.dp))
                                    WeeklyBars(weekly)
                                }
                            }
                        }
                    }
                    item { RecentActivityHeader(onOpenDrives) }
                    if (recent.isEmpty()) {
                        item { EmptyLine("Nothing driven yet. Start a drive and it will show up here.") }
                    } else {
                        items(recent) { RecentActivityRow(it) }
                    }
                }

                ProgressTab.Areas -> {
                    val list = paces.filter { it.area.level == AreaLevel.NEIGHBORHOOD }
                    if (list.isEmpty()) item { EmptyLine("No neighbourhoods yet.") }
                    else items(list) { AreaProgressCard(it) }
                }

                ProgressTab.Cities -> {
                    val list = paces.filter { it.area.level != AreaLevel.NEIGHBORHOOD }
                    if (list.isEmpty()) item { EmptyLine("No cities or metro areas yet. Add one from the Areas tab.") }
                    else items(list) { AreaProgressCard(it) }
                }
            }
        }
    }
}

@Composable
private fun TotalProgressCard(o: Overview) {
    Card {
        Column(Modifier.padding(16.dp)) {
            Text("Total progress", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(14.dp))
            RingWithLegend(fraction = o.fraction, diameter = 104.dp) {
                LegendLine("Driven streets", "%,d".format(o.drivenStreets), MaterialTheme.colorScheme.primary)
                LegendLine("Still to drive", "%,d".format(o.unvisitedStreets), MaterialTheme.colorScheme.outline)
                LegendLine("Total streets", "%,d".format(o.totalStreets))
            }
            if (o.metersTotal > 0) {
                Spacer(Modifier.height(14.dp))
                Text(
                    "${Geo.formatDistance(o.metersDriven)} of ${Geo.formatDistance(o.metersTotal)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun AreasTally(o: Overview) {
    Card {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Tally("Completed", o.areasCompleted, MaterialTheme.colorScheme.primary, Modifier.weight(1f))
            Tally("In progress", o.areasInProgress, MaterialTheme.colorScheme.tertiary, Modifier.weight(1f))
        }
    }
}

@Composable
private fun Tally(label: String, value: Int, colour: Color, modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(width = 4.dp, height = 34.dp).clip(RoundedCornerShape(2.dp)).background(colour))
        Spacer(Modifier.width(12.dp))
        Column {
            Text("$value", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun DistanceCard(o: Overview) {
    Card {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Straighten, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text("Distance driven", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    Geo.formatDistance(o.lifetimeMeters),
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold,
                )
            }
        }
    }
}

@Composable
private fun RecentActivityHeader(onOpenDrives: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(
            "Recent activity",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = onOpenDrives) { Text("See all drives") }
    }
}

@Composable
private fun RecentActivityRow(pace: AreaPace) {
    val done = pace.isComplete
    Card {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(
                if (done) Icons.Default.CheckCircle else Icons.Default.Adjust,
                contentDescription = null,
                tint = if (done) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.tertiary,
            )
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(pace.area.name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Text(
                    buildString {
                        append(if (done) "Completed" else "In progress")
                        pace.lastProgressWeek?.let { append(" · ${Format.date(it)}") }
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                "${pace.area.stats.percent}%",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
                color = if (done) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

@Composable
private fun EmptyLine(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(vertical = 8.dp),
    )
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
