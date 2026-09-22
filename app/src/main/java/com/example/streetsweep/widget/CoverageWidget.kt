package com.example.streetsweep.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import com.example.streetsweep.MainActivity
import com.example.streetsweep.R
import com.example.streetsweep.appContainer
import com.example.streetsweep.data.AreaWithStats
import com.example.streetsweep.domain.Geo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * Home screen widget showing how one area is coming along. Picks the area you have made the
 * most progress in lately, falling back to the largest, so it tracks whatever you are sweeping.
 */
class CoverageWidget : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val pending = goAsync()
        CoroutineScope(Dispatchers.Default).launch {
            try {
                val areas = context.appContainer.coverageRepository.observeAreasWithStats().first()
                val views = render(context, pick(areas))
                ids.forEach { manager.updateAppWidget(it, views) }
            } finally {
                pending.finish()
            }
        }
    }

    private fun pick(areas: List<AreaWithStats>): AreaWithStats? =
        areas.filter { it.stats.total > 0 }
            .minByOrNull { it.area.level } // the smallest level is the one being actively swept
            ?: areas.firstOrNull()

    private fun render(context: Context, area: AreaWithStats?): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.widget_coverage)
        if (area == null) {
            views.setTextViewText(R.id.widget_name, "StreetSweep")
            views.setTextViewText(R.id.widget_percent, "–")
            views.setTextViewText(R.id.widget_detail, "Add a coverage area to start")
            views.setProgressBar(R.id.widget_progress, 100, 0, false)
        } else {
            views.setTextViewText(R.id.widget_name, area.name)
            views.setTextViewText(R.id.widget_percent, "${area.stats.percent}%")
            views.setTextViewText(
                R.id.widget_detail,
                "${area.stats.remaining} streets to go · ${Geo.formatDistance(area.stats.metersDriven)} of ${Geo.formatDistance(area.stats.metersTotal)}",
            )
            views.setProgressBar(R.id.widget_progress, 100, area.stats.percent, false)
        }
        views.setOnClickPendingIntent(
            R.id.widget_root,
            PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            ),
        )
        return views
    }

    companion object {
        /** Nudges every placed widget, for use after a drive changes the numbers. */
        fun refresh(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, CoverageWidget::class.java))
            if (ids.isEmpty()) return
            context.sendBroadcast(
                Intent(context, CoverageWidget::class.java)
                    .setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
                    .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids),
            )
        }
    }
}
