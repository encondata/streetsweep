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
import androidx.compose.material.icons.filled.Share
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import com.example.streetsweep.data.PlacePhotos
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.map
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

    /** Your shared teams, to share a place with. */
    val teams: StateFlow<List<com.example.streetsweep.data.db.TeamEntity>> = container.database.serverDao().observeTeams()
        .map { all -> all.filter { !it.isPersonal } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    fun setTeams(id: Long, teamIds: List<String>) = viewModelScope.launch {
        container.trackRepository.setPoiTeams(id, teamIds)
        com.example.streetsweep.data.server.SyncWorker.enqueue(context)
    }

    /**
     * The first photo the server holds for a place (added on the web, or by whoever shared
     * it), fetched once and kept in the app's cache.
     */
    suspend fun serverPhoto(p: Poi): android.graphics.Bitmap? = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
        val photoId = p.serverPhotos.split(',').firstOrNull { it.isNotBlank() } ?: return@withContext null
        val file = java.io.File(context.cacheDir, "place-photos/$photoId.jpg")
        if (!file.exists()) {
            val bytes = runCatching { container.server.placePhoto(p.uuid, photoId) }.getOrNull() ?: return@withContext null
            file.parentFile?.mkdirs()
            file.writeBytes(bytes)
        }
        runCatching { android.graphics.BitmapFactory.decodeFile(file.path, android.graphics.BitmapFactory.Options().apply { inSampleSize = 4 }) }.getOrNull()
    }
}

@Composable
fun PlacesScreen(
    onBack: () -> Unit,
    onShowOnMap: () -> Unit,
    viewModel: PlacesViewModel = containerViewModel { c, ctx -> PlacesViewModel(c, ctx) },
) {
    val pois by viewModel.pois.collectAsStateWithLifecycle()
    val teams by viewModel.teams.collectAsStateWithLifecycle()
    var sharing by remember { mutableStateOf<Poi?>(null) }
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
                    leadingContent = { PlaceThumb(p, viewModel::serverPhoto) },
                    headlineContent = { Text(p.name ?: p.note ?: "Marked spot") },
                    supportingContent = {
                        val shared = p.teamIds.split(',').filter { it.isNotBlank() }
                        Text(
                            Format.dateTime(p.timestamp) + " · " +
                                when {
                                    !p.mine -> "Shared by ${p.ownerName ?: "a teammate"}"
                                    shared.isNotEmpty() -> "Shared with " + shared.mapNotNull { id -> teams.firstOrNull { it.id == id }?.name }.ifEmpty { listOf("a team") }.joinToString(", ")
                                    else -> "Only you"
                                },
                        )
                    },
                    trailingContent = {
                        // Someone else's place is theirs to change; here it can only be looked at.
                        if (p.mine) androidx.compose.foundation.layout.Row {
                            if (teams.isNotEmpty()) IconButton(onClick = { sharing = p }) { Icon(Icons.Default.Share, contentDescription = "Share with a team") }
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
    sharing?.let { p ->
        var chosen by remember(p.id) { mutableStateOf(p.teamIds.split(',').filter { it.isNotBlank() }.toSet()) }
        AlertDialog(
            onDismissRequest = { sharing = null },
            title = { Text("Who sees it") },
            text = {
                androidx.compose.foundation.layout.Column {
                    Text("Only you, unless you share it. Members of a team you share it with can see it and its photos; only you can change it.",
                        style = MaterialTheme.typography.bodySmall)
                    teams.forEach { t ->
                        androidx.compose.foundation.layout.Row(
                            Modifier.fillMaxWidth().clickable { chosen = if (t.id in chosen) chosen - t.id else chosen + t.id },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            androidx.compose.material3.Checkbox(checked = t.id in chosen, onCheckedChange = { on -> chosen = if (on) chosen + t.id else chosen - t.id })
                            Text(t.name)
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { viewModel.setTeams(p.id, chosen.toList()); sharing = null }) { Text("Save") } },
            dismissButton = { TextButton(onClick = { sharing = null }) { Text("Cancel") } },
        )
    }
    pendingDelete?.let { p ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("Delete this spot?") },
            text = { Text((p.name ?: p.note ?: Format.dateTime(p.timestamp)) + "\n\nIt is deleted from the web too, at the next sync.") },
            confirmButton = { TextButton(onClick = { viewModel.delete(p.id); pendingDelete = null }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { pendingDelete = null }) { Text("Cancel") } },
        )
    }
}

/** The photo, if one was taken here (or is on the server), small enough to sit in a list row. */
@Composable
private fun PlaceThumb(p: Poi, serverPhoto: suspend (Poi) -> android.graphics.Bitmap?) {
    val path = p.photoPath
    if (path == null && p.serverPhotos.isNotBlank()) {
        val fetched by androidx.compose.runtime.produceState<android.graphics.Bitmap?>(null, p.uuid, p.serverPhotos) { value = serverPhoto(p) }
        fetched?.let {
            Image(bitmap = it.asImageBitmap(), contentDescription = "Photo of this spot", contentScale = ContentScale.Crop,
                modifier = Modifier.size(44.dp).clip(RoundedCornerShape(8.dp)))
            return
        }
    }
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
