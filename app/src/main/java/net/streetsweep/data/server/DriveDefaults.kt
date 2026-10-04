package net.streetsweep.data.server

import net.streetsweep.data.db.AppDatabase
import net.streetsweep.data.prefs.SettingsRepository
import net.streetsweep.domain.TriggerSource

/**
 * The drive type and vehicle a drive starts with, so an automatic start never has to ask
 * anyone anything. Both can be changed while driving and until the drive goes up, and on
 * the web after that.
 *
 * Vehicle: the car whose Bluetooth started the drive, if it's linked to one; else the
 * vehicle you have checked out; else your only permanent car; else none (the server then
 * works it out from your assignments at the time, or leaves it blank).
 * Type: the last one used; else Personal.
 */
object DriveDefaults {
    suspend fun pick(db: AppDatabase, settings: SettingsRepository, trigger: TriggerSource): Pair<String, String?> {
        val s = settings.current()
        val types = db.serverDao().getDriveTypes()
        val type = s.lastDriveType?.takeIf { k -> types.isEmpty() || types.any { it.key == k } } ?: PERSONAL
        val vehicles = db.serverDao().getVehicles()
        val linked = s.bluetoothTriggerAddress?.takeIf { trigger == TriggerSource.BLUETOOTH }
            ?.let { s.bluetoothVehicles[it] }?.takeIf { id -> vehicles.any { it.id == id } }
        val checkedOut = vehicles.firstOrNull { it.checkoutUserId != null && it.checkoutUserId == s.serverUserId }?.id
        val onlyPermanent = vehicles.filter { it.permanent }.singleOrNull()?.id
        return type to (linked ?: checkedOut ?: onlyPermanent)
    }

    /** "Delivery · Van 9", for the notification and the recording card. */
    suspend fun label(db: AppDatabase, type: String?, vehicleId: String?): String {
        val t = db.serverDao().getDriveTypes().firstOrNull { it.key == (type ?: PERSONAL) }?.label ?: (type ?: "Personal").replaceFirstChar { it.uppercase() }
        val v = vehicleId?.let { id -> db.serverDao().getVehicles().firstOrNull { it.id == id }?.name }
        return listOfNotNull(t, v ?: "no vehicle").joinToString(" · ")
    }

    const val PERSONAL = "personal"
}
