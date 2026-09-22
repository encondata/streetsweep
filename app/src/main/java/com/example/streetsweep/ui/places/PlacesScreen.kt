@file:OptIn(ExperimentalMaterial3Api::class)

package com.example.streetsweep.ui.places

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.example.streetsweep.AppContainer
import com.example.streetsweep.data.db.Poi
import com.example.streetsweep.domain.Bounds
import com.example.streetsweep.ui.common.Format
import com.example.streetsweep.ui.common.containerViewModel
import com.example.streetsweep.ui.map.MapFocus
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.Locale

class PlacesViewModel(private val container: AppContainer) : ViewModel() {
    val pois: StateFlow<List<Poi>> = container.trackRepository.observePois()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    fun setNote(id: Long, note: String) = viewModelScope.launch { container.trackRepository.setPoiNote(id, note) }
    fun delete(id: Long) = viewModelScope.launch { container.trackRepository.deletePoi(id) }
}

@Composable
fun PlacesScreen(
    onBack: () -> Unit,
    onShowOnMap: () -> Unit,
    viewModel: PlacesViewModel = containerViewModel { c, _ -> PlacesViewModel(c) },
) {
    val pois by viewModel.pois.collectAsStateWithLifecycle()
    var editing by remember { mutableStateOf<Poi?>(null) }
    var pendingDelete by remember { mutableStateOf<Poi?>(null) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Marked spots") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
            )
        },
    ) { padding ->
        if (pois.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Text(
                    "Nothing marked yet. Tap the flag on the map (or Mark on the car screen) to save your current position.",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(32.dp),
                )
            }
            return@Scaffold
        }
        LazyColumn(Modifier.fillMaxSize().padding(padding)) {
            items(pois, key = { it.id }) { p ->
                ListItem(
                    modifier = Modifier.clickable {
                        val d = 0.002
                        MapFocus.request(Bounds(p.latitude - d, p.longitude - d, p.latitude + d, p.longitude + d))
                        onShowOnMap()
                    },
                    headlineContent = { Text(p.note ?: "No note") },
                    supportingContent = {
                        Text(
                            Format.dateTime(p.timestamp) + " · " +
                                String.format(Locale.US, "%.5f, %.5f", p.latitude, p.longitude) +
                                (if (p.accuracyMeters > 0) String.format(Locale.US, " · ±%.0f m", p.accuracyMeters) else ""),
                        )
                    },
                    trailingContent = {
                        androidx.compose.foundation.layout.Row {
                            TextButton(onClick = { editing = p }) { Text("Note") }
                            IconButton(onClick = { pendingDelete = p }) { Icon(Icons.Default.Delete, contentDescription = "Delete") }
                        }
                    },
                )
                HorizontalDivider()
            }
        }
    }

    editing?.let { p ->
        var note by remember(p.id) { mutableStateOf(p.note.orEmpty()) }
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text("Note") },
            text = { OutlinedTextField(value = note, onValueChange = { note = it }, minLines = 2, modifier = Modifier.fillMaxWidth()) },
            confirmButton = { TextButton(onClick = { viewModel.setNote(p.id, note); editing = null }) { Text("Save") } },
            dismissButton = { TextButton(onClick = { editing = null }) { Text("Cancel") } },
        )
    }
    pendingDelete?.let { p ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("Delete this spot?") },
            text = { Text(p.note ?: Format.dateTime(p.timestamp)) },
            confirmButton = { TextButton(onClick = { viewModel.delete(p.id); pendingDelete = null }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { pendingDelete = null }) { Text("Cancel") } },
        )
    }
}
