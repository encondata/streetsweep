package com.example.streetsweep.data

import android.content.Context
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File

/**
 * Where a photo of a marked place lives on the phone.
 *
 * In the app's own files, not the gallery: these are working notes about an address, not
 * pictures anyone wants mixed in with their holidays, and keeping them private means no
 * storage permission to ask for.
 */
object PlacePhotos {

    private const val FOLDER = "place-photos"

    fun folder(context: Context): File =
        File(context.filesDir, FOLDER).apply { mkdirs() }

    fun fileFor(context: Context, poiId: Long): File =
        File(folder(context), "poi-$poiId.jpg")

    /** A URI the camera app is allowed to write to, and nothing more. */
    fun writableUri(context: Context, file: File): Uri =
        FileProvider.getUriForFile(context, "${context.packageName}.photos", file)

    fun delete(context: Context, poiId: Long) {
        fileFor(context, poiId).delete()
    }
}
