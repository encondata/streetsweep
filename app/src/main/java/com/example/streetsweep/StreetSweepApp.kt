package com.example.streetsweep

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.Map
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.example.streetsweep.ui.areas.AreasScreen
import com.example.streetsweep.ui.home.HomeScreen
import com.example.streetsweep.ui.places.PlacesScreen
import com.example.streetsweep.ui.stats.StatsScreen
import com.example.streetsweep.ui.streets.StreetsScreen
import com.example.streetsweep.ui.sessions.SessionDetailScreen
import com.example.streetsweep.ui.sessions.SessionsScreen
import com.example.streetsweep.ui.settings.SettingsScreen

private enum class Destination(val route: String, val label: String, val icon: ImageVector) {
    Home("home", "Map", Icons.Default.Map),
    Sessions("sessions", "Drives", Icons.AutoMirrored.Filled.List),
    Areas("areas", "Areas", Icons.Default.Layers),
    Settings("settings", "Settings", Icons.Default.Settings),
}

private const val SESSION_ROUTE = "session/{id}"

/** Root of the app's UI: bottom navigation between the map, the drive list and settings. */
@Composable
fun StreetSweepApp() {
    val navController = rememberNavController()
    val backStack by navController.currentBackStackEntryAsState()
    val currentRoute = backStack?.destination?.route

    fun navigateTop(dest: Destination) = navController.navigate(dest.route) {
        popUpTo(navController.graph.findStartDestination().id) { saveState = true }
        launchSingleTop = true
        restoreState = true
    }

    Scaffold(
        // Screens handle the status bar themselves (top app bars, the map's card); the shell
        // must not pad for it too or everything sits a status-bar height too low.
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        bottomBar = {
            NavigationBar {
                Destination.entries.forEach { dest ->
                    NavigationBarItem(
                        selected = currentRoute == dest.route ||
                            (dest == Destination.Sessions && currentRoute == SESSION_ROUTE),
                        onClick = { navigateTop(dest) },
                        icon = { Icon(dest.icon, contentDescription = null) },
                        label = { Text(dest.label) },
                    )
                }
            }
        },
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = Destination.Home.route,
            modifier = Modifier.padding(padding),
        ) {
            composable(Destination.Home.route) {
                HomeScreen(onOpenSettings = { navigateTop(Destination.Settings) })
            }
            composable(Destination.Sessions.route) {
                SessionsScreen(
                    onOpenSession = { id -> navController.navigate("session/$id") },
                    onOpenPlaces = { navController.navigate("places") },
                    onOpenStats = { navController.navigate("stats") },
                )
            }
            composable("stats") { StatsScreen(onBack = { navController.popBackStack() }) }
            composable("places") {
                PlacesScreen(onBack = { navController.popBackStack() }, onShowOnMap = { navigateTop(Destination.Home) })
            }
            composable(Destination.Areas.route) {
                AreasScreen(
                    onShowOnMap = { navigateTop(Destination.Home) },
                    onOpenStreets = { id -> navController.navigate("streets/$id") },
                )
            }
            composable(
                "streets/{areaId}",
                arguments = listOf(navArgument("areaId") { type = NavType.LongType }),
            ) { entry ->
                StreetsScreen(
                    areaId = entry.arguments?.getLong("areaId") ?: 0L,
                    onBack = { navController.popBackStack() },
                    onShowOnMap = { navigateTop(Destination.Home) },
                )
            }
            composable(Destination.Settings.route) { SettingsScreen() }
            composable(
                SESSION_ROUTE,
                arguments = listOf(navArgument("id") { type = NavType.LongType }),
            ) { entry ->
                SessionDetailScreen(
                    sessionId = entry.arguments?.getLong("id") ?: 0L,
                    onBack = { navController.popBackStack() },
                )
            }
        }
    }
}
