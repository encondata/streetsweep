package com.example.streetsweep.ui.common

import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.example.streetsweep.AppContainer
import com.example.streetsweep.appContainer

/** Obtains a ViewModel built from the app container, keyed so per-item view models don't collide. */
@Composable
inline fun <reified VM : ViewModel> containerViewModel(
    key: String? = null,
    crossinline create: (AppContainer, android.content.Context) -> VM,
): VM {
    val appContext = LocalContext.current.applicationContext
    return viewModel(
        key = key,
        factory = viewModelFactory { initializer { create(appContext.appContainer, appContext) } },
    )
}
