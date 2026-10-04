package net.streetsweep.ui.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import net.streetsweep.AppContainer
import net.streetsweep.data.db.SessionTotalsRow
import net.streetsweep.data.db.TrackSession
import net.streetsweep.domain.LatLngPoint
import net.streetsweep.tracking.TrackingStateHolder
import net.streetsweep.tracking.TrackingStatus
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

    /** Your street colours, so the route is drawn in your "driven" colour. */
    val palette: StateFlow<net.streetsweep.data.prefs.MapPalette> = container.settings.settings.map { it.mapPalette }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), net.streetsweep.data.prefs.MapPalette.DEFAULT)

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
            // The server matches drives; the phone's preview is redone and the drive sent now.
            _message.value = runCatching {
                container.provisional.update(sessionId)
                net.streetsweep.data.server.SyncWorker.enqueue(container.context)
                val s = container.trackRepository.getSession(sessionId)
                when {
                    s?.serverStatus == "matched" -> "Matched by the server"
                    s?.uploadedAt != null -> "Sent; the server is matching it"
                    else -> "Sending to the server to be matched…"
                }
            }.getOrElse { "Couldn't: ${it.message}" }
            _snapping.value = false
        }
    }

    fun clearMessage() {
        _message.value = null
    }
}
