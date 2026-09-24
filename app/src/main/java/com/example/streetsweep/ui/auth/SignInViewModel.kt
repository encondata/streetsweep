package com.example.streetsweep.ui.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.streetsweep.AppContainer
import com.example.streetsweep.data.prefs.TrackingSettings
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * The sign-in gate that sits in front of the app.
 *
 * Signing in is not buried in Settings any more: with no token and no decision to go
 * without one, this is the first thing the app shows. Signing out clears both, so the
 * gate comes straight back rather than leaving someone looking at a map they are no
 * longer signed in to.
 */
class SignInViewModel(private val container: AppContainer) : ViewModel() {

    val settings: StateFlow<TrackingSettings> = container.settings.settings
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), TrackingSettings())

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error

    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice

    fun clearMessages() { _error.value = null; _notice.value = null }

    /** For the parts of the design that are drawn but have nowhere to go yet. */
    fun notBuiltYet(what: String) {
        _error.value = null
        _notice.value = "$what is not set up yet. An administrator can do it for you in the meantime."
    }

    fun signIn(email: String, password: String) = viewModelScope.launch {
        if (_busy.value) return@launch
        _busy.value = true
        _error.value = null
        _notice.value = null
        try {
            val label = android.os.Build.MODEL?.takeIf { it.isNotBlank() } ?: "Phone"
            val result = container.portalClient.signInDevice(email, password, label)
            // Storing the token also clears the standalone choice, which is what takes
            // the gate down.
            container.settings.setPortalIdentity(result.token, result.name, result.email)
        } catch (e: Exception) {
            _error.value = e.message ?: "Could not sign in"
        } finally {
            _busy.value = false
        }
    }

    /** Sign-in is in front of Settings, so the server address has to be settable here. */
    fun setServer(address: String) = viewModelScope.launch {
        val clean = address.trim()
        if (clean.isEmpty()) return@launch
        container.settings.setPortalUrl(clean)
        clearMessages()
    }

    /** "Keep using it on this phone only" — remembered, or it would ask at every launch. */
    fun useWithoutAnAccount() = viewModelScope.launch {
        container.settings.setStandalone(true)
        clearMessages()
    }

    fun signOut() = viewModelScope.launch { container.settings.clearPortalIdentity() }
}
