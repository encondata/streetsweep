package com.example.streetsweep.ui.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.streetsweep.AppContainer
import com.example.streetsweep.data.db.SessionTotalsRow
import com.example.streetsweep.data.db.TrackSession
import com.example.streetsweep.data.osm.RoadMatcher
import com.example.streetsweep.domain.LatLngPoint
import com.example.streetsweep.tracking.TrackingStateHolder
import com.example.streetsweep.tracking.TrackingStatus
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class SessionsViewModel(private val container: AppContainer) : ViewModel() {
    val sessions: StateFlow<List<TrackSession>> = container.trackRepository.observeSessions()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    val totals: StateFlow<SessionTotalsRow?> = container.trackRepository.observeTotals()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    val activeSessionId: StateFlow<Long?> = TrackingStateHolder.status
        .map { (it as? TrackingStatus.Recording)?.sessionId }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    fun delete(sessionId: Long) {
        viewModelScope.launch { container.trackRepository.deleteSession(sessionId) }
    }
}

class SessionDetailViewModel(private val container: AppContainer, private val sessionId: Long) : ViewModel() {
    val session: StateFlow<TrackSession?> = container.trackRepository.observeSession(sessionId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    val raw: StateFlow<List<LatLngPoint>> = container.trackRepository.observePoints(sessionId)
        .map { pts -> pts.map { LatLngPoint(it.latitude, it.longitude) } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    val snapped: StateFlow<List<LatLngPoint>> = container.trackRepository.observeSnappedPoints(sessionId)
        .map { pts -> pts.map { LatLngPoint(it.latitude, it.longitude) } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    private val _snapping = MutableStateFlow(false)
    val snapping: StateFlow<Boolean> = _snapping

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message

    fun snapNow() {
        if (_snapping.value) return
        viewModelScope.launch {
            _snapping.value = true
            _message.value = when (val r = container.roadMatcher.matchSession(sessionId)) {
                is RoadMatcher.Result.Matched -> "Matched: ${r.newEdges} new segments, ${com.example.streetsweep.domain.Geo.formatDistance(r.newMeters)} of new streets"
                RoadMatcher.Result.NothingNew -> "Already matched to roads"
                RoadMatcher.Result.NotEnoughPoints -> "Need at least 2 points to match"
                is RoadMatcher.Result.Failed -> "Matching failed: ${r.message}"
            }
            _snapping.value = false
        }
    }

    fun clearMessage() {
        _message.value = null
    }
}
