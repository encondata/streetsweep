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
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.filled.BrokenImage
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.Place
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import com.example.streetsweep.data.PlacePhotos
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.Locale

class PlacesViewModel(
    private val container: AppContainer,
    private val context: android.content.Context,
) : ViewModel() {
    val pois: StateFlow<List<Poi>> = container.trackRepository.observePois()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    fun setDetails(id: Long, name: String, note: String) = viewModelScope.launch {
        container.trackRepository.setPoiDetails(id, name, note)
    }

    fun delete(id: Long) = viewModelScope.launch {
        PlacePhotos.delete(context, id)
        container.trackRepository.deletePoi(id)
    }

    /** Where the camera should write, handed out just before it is asked to. */
    fun photoTarget(id: Long): android.net.Uri {
        val file = PlacePhotos.fileFor(context, id)
        file.parentFile?.mkdirs()
        return PlacePhotos.writableUri(context, file)
    }

    fun photoTaken(id: Long) = viewModelScope.launch {
        val file = PlacePhotos.fileFor(context, id)
        container.trackRepository.setPoiPhoto(id, if (file.exists() && file.length() > 0) file.path else null)
    }

    fun dropPhoto(id: Long) = viewModelScope.launch {
        PlacePhotos.delete(context, id)
        container.trackRepository.setPoiPhoto(id, null)
    }
}

@Composable
fun PlacesScreen(
    onBack: () -> Unit,
    onShowOnMap: () -> Unit,
    viewModel: PlacesViewModel = containerViewModel { c, ctx -> PlacesViewModel(c, ctx) },
) {
    val pois by viewModel.pois.collectAsStateWithLifecycle()
    var editing by remember { mutableStateOf<Poi?>(null) }
    var pendingDelete by remember { mutableStateOf<Poi?>(null) }
    var awaitingPhotoFor by remember { mutableStateOf<Long?>(null) }

    val takePhoto = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
        awaitingPhotoFor?.let { if (saved) viewModel.photoTaken(it) }
        awaitingPhotoFor = null
    }

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
                    leadingContent = { PlaceThumb(p) },
                    headlineContent = { Text(p.name ?: p.note ?: "Marked spot") },
                    supportingContent = {
                        Text(
                            Format.dateTime(p.timestamp) + " · " +
                                String.format(Locale.US, "%.5f, %.5f", p.latitude, p.longitude) +
                                (if (p.accuracyMeters > 0) String.format(Locale.US, " · ±%.0f m", p.accuracyMeters) else ""),
                        )
                    },
                    trailingContent = {
                        androidx.compose.foundation.layout.Row {
                            IconButton(onClick = {
                                awaitingPhotoFor = p.id
                                takePhoto.launch(viewModel.photoTarget(p.id))
                            }) { Icon(Icons.Default.PhotoCamera, contentDescription = "Take a photo") }
                            TextButton(onClick = { editing = p }) { Text("Edit") }
                            IconButton(onClick = { pendingDelete = p }) { Icon(Icons.Default.Delete, contentDescription = "Delete") }
                        }
                    },
                )
                HorizontalDivider()
            }
        }
    }

    editing?.let { p ->
        var name by remember(p.id) { mutableStateOf(p.name.orEmpty()) }
        var note by remember(p.id) { mutableStateOf(p.note.orEmpty()) }
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text("Marked spot") },
            text = {
                androidx.compose.foundation.layout.Column {
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        label = { Text("Name") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    androidx.compose.foundation.layout.Spacer(Modifier.height(10.dp))
                    OutlinedTextField(
                        value = note,
                        onValueChange = { note = it },
                        label = { Text("Notes") },
                        minLines = 2,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (p.photoPath != null) {
                        androidx.compose.foundation.layout.Spacer(Modifier.height(10.dp))
                        TextButton(onClick = { viewModel.dropPhoto(p.id); editing = null }) { Text("Remove the photo") }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { viewModel.setDetails(p.id, name, note); editing = null }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { editing = null }) { Text("Cancel") } },
        )
    }
    pendingDelete?.let { p ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("Delete this spot?") },
            text = { Text(p.name ?: p.note ?: Format.dateTime(p.timestamp)) },
            confirmButton = { TextButton(onClick = { viewModel.delete(p.id); pendingDelete = null }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { pendingDelete = null }) { Text("Cancel") } },
        )
    }
}

/** The photo, if one was taken here, small enough to sit in a list row. */
@Composable
private fun PlaceThumb(p: Poi) {
    val path = p.photoPath
    if (path == null) {
        Icon(
            Icons.Default.Place,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(44.dp).padding(10.dp),
        )
        return
    }
    val bitmap = remember(path, p.updatedAt) {
        runCatching {
            android.graphics.BitmapFactory.decodeFile(
                path,
                android.graphics.BitmapFactory.Options().apply { inSampleSize = 8 },
            )
        }.getOrNull()
    }
    if (bitmap == null) {
        Icon(
            Icons.Default.BrokenImage,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(44.dp).padding(10.dp),
        )
    } else {
        Image(
            bitmap = bitmap.asImageBitmap(),
            contentDescription = "Photo of this spot",
            contentScale = ContentScale.Crop,
            modifier = Modifier
                .size(44.dp)
                .clip(RoundedCornerShape(8.dp)),
        )
    }
}
