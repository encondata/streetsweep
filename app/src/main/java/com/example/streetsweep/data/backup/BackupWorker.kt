package com.example.streetsweep.data.backup

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.documentfile.provider.DocumentFile
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.example.streetsweep.appContainer
import java.util.concurrent.TimeUnit

/**
 * Writes a database backup into the folder the user picked, and keeps the most recent few.
 * Runs daily; the interval the user chose is checked inside, so changing it takes effect
 * without rescheduling.
 */
class BackupWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val container = applicationContext.appContainer
        val settings = container.settings.current()
        if (settings.backupEveryDays <= 0) return Result.success()
        val folderUri = settings.backupFolderUri?.let { Uri.parse(it) } ?: return Result.success()
        val due = settings.lastBackupAt + settings.backupEveryDays * DAY_MS
        if (System.currentTimeMillis() < due) return Result.success()

        return try {
            val folder = DocumentFile.fromTreeUri(applicationContext, folderUri)
                ?: return Result.failure()
            if (!folder.canWrite()) {
                Log.w(TAG, "Backup folder is no longer writable")
                return Result.failure()
            }
            val now = System.currentTimeMillis()
            val file = folder.createFile(BackupFiles.DATABASE_MIME, BackupFiles.database(now))
                ?: return Result.retry()
            applicationContext.contentResolver.openOutputStream(file.uri)?.use { out ->
                container.backupManager.writeDatabaseBackup(out)
            } ?: return Result.retry()
            container.settings.setLastBackupAt(now)
            trim(folder)
            Result.success()
        } catch (e: Exception) {
            Log.w(TAG, "Automatic backup failed", e)
            Result.retry()
        }
    }

    /** Keeps the newest [KEEP] backups so the folder does not grow without bound. */
    private fun trim(folder: DocumentFile) {
        val ours = folder.listFiles()
            .filter { BackupFiles.isDatabaseBackup(it.name) }
            .sortedByDescending { it.name }
        ours.drop(KEEP).forEach { runCatching { it.delete() } }
    }

    companion object {
        private const val TAG = "BackupWorker"
        private const val DAY_MS = 24L * 60 * 60 * 1000
        private const val KEEP = 8
        private const val UNIQUE = "auto-backup"

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<BackupWorker>(1, TimeUnit.DAYS).build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(UNIQUE, ExistingPeriodicWorkPolicy.UPDATE, request)
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(UNIQUE)
        }
    }
}
