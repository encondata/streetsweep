package com.example.streetsweep.ui.auth

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MailOutline
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.streetsweep.R

/**
 * The sign-in screen, built to the supplied design: the night map behind, the mark and
 * lockup above a translucent card, iconed fields with a reveal on the password, the
 * gradient button, and the three things the app does along the bottom.
 *
 * The background is drawn rather than shipped as a photograph — the same reason the web
 * page draws its own: a photo would be a megabyte of someone else's neighbourhood, and
 * this rescales to any handset for nothing.
 */

private val Navy950 = Color(0xFF02142A)
private val Navy900 = Color(0xFF0A1F35)
private val NavyLift = Color(0xFF123B5E)
private val RoadDim = Color(0xFF2B4A68)
private val GreenBright = Color(0xFF45BD23)
private val GreenDeep = Color(0xFF1E8A28)
private val InkSoft = Color(0xFF93A6BA)
private val Ink = Color(0xFFEAF1F8)
private val FieldFill = Color(0x0DFFFFFF)
private val LineSoft = Color(0x1FFFFFFF)

@Composable
fun SignInScreen(
    busy: Boolean,
    error: String?,
    /** A remark, not a failure — shown in the same place but not dressed as an error. */
    notice: String?,
    serverLabel: String,
    onSignIn: (email: String, password: String) -> Unit,
    /** Saves a new server address. The gate is in front of Settings, so it has to be
     *  changeable from here or a self-hosted server cannot be reached on a fresh phone. */
    onChangeServer: (String) -> Unit,
    /** Shown on the parts of the design that are drawn but not built yet. */
    onPlaceholder: (String) -> Unit,
    onSkip: (() -> Unit)? = null,
) {
    var email by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var reveal by rememberSaveable { mutableStateOf(false) }
    var remember by rememberSaveable { mutableStateOf(true) }
    var editingServer by rememberSaveable { mutableStateOf(false) }
    var serverField by rememberSaveable(serverLabel) { mutableStateOf(serverLabel) }
    val focus = LocalFocusManager.current

    Surface(Modifier.fillMaxSize(), color = Navy950) {
        // The supplied photograph, with the drawn map still underneath it: that is what
        // fills the screen for the moment before a 300 KB JPEG is decoded.
        Box(Modifier.fillMaxSize().nightMap()) {
            Image(
                painter = painterResource(R.drawable.signin_photo),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
            // Nothing in the photograph is dark enough on its own to read white text on.
            Box(
                Modifier
                    .fillMaxSize()
                    .background(
                        Brush.verticalGradient(
                            0.00f to Navy950.copy(alpha = 0.55f),
                            0.28f to Navy950.copy(alpha = 0.82f),
                            0.72f to Navy950.copy(alpha = 0.82f),
                            1.00f to Navy950.copy(alpha = 0.60f),
                        ),
                    ),
            )
        }
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .statusBarsPadding()
                .navigationBarsPadding()
                .imePadding()
                .padding(horizontal = 22.dp, vertical = 18.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(18.dp))
            Image(
                painter = painterResource(R.drawable.splash_icon),
                contentDescription = null,
                modifier = Modifier.size(104.dp),
            )
            Spacer(Modifier.height(12.dp))
            Image(
                painter = painterResource(R.drawable.signin_lockup),
                contentDescription = "StreetSweep — drive, explore, complete",
                modifier = Modifier.fillMaxWidth(0.68f),
            )

            Spacer(Modifier.height(26.dp))

            Surface(
                shape = RoundedCornerShape(18.dp),
                color = Navy900.copy(alpha = 0.78f),
                border = androidx.compose.foundation.BorderStroke(1.dp, LineSoft),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(Modifier.padding(22.dp)) {
                    Text(
                        "Sign In",
                        color = Ink,
                        fontSize = 25.sp,
                        fontWeight = FontWeight.Bold,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "Access your maps, drives, and progress.",
                        color = InkSoft,
                        fontSize = 13.sp,
                    )

                    val banner = error ?: notice
                    if (banner != null) {
                        val bad = error != null
                        Spacer(Modifier.height(14.dp))
                        Surface(
                            shape = RoundedCornerShape(10.dp),
                            color = if (bad) Color(0x22FF8579) else Color(0x1A57C7FF),
                            border = androidx.compose.foundation.BorderStroke(
                                1.dp,
                                if (bad) Color(0x55FF8579) else Color(0x4D57C7FF),
                            ),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(
                                banner,
                                color = if (bad) Color(0xFFFF9C92) else Color(0xFF9BD9F7),
                                fontSize = 12.5.sp,
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp),
                            )
                        }
                    }

                    Spacer(Modifier.height(16.dp))
                    OutlinedTextField(
                        value = email,
                        onValueChange = { email = it },
                        placeholder = { Text("Email address", color = InkSoft) },
                        leadingIcon = { Icon(Icons.Default.MailOutline, null, tint = InkSoft) },
                        singleLine = true,
                        enabled = !busy,
                        shape = RoundedCornerShape(12.dp),
                        colors = fieldColours(),
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Email,
                            imeAction = ImeAction.Next,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    )

                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it },
                        placeholder = { Text("Password", color = InkSoft) },
                        leadingIcon = { Icon(Icons.Default.Lock, null, tint = InkSoft) },
                        trailingIcon = {
                            IconButton(onClick = { reveal = !reveal }) {
                                Icon(
                                    painterResource(
                                        if (reveal) R.drawable.ic_eye_off else R.drawable.ic_eye,
                                    ),
                                    contentDescription = if (reveal) "Hide the password" else "Show the password",
                                    tint = InkSoft,
                                )
                            }
                        },
                        singleLine = true,
                        enabled = !busy,
                        shape = RoundedCornerShape(12.dp),
                        colors = fieldColours(),
                        visualTransformation =
                            if (reveal) VisualTransformation.None else PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Password,
                            imeAction = ImeAction.Done,
                        ),
                        keyboardActions = KeyboardActions(onDone = {
                            focus.clearFocus()
                            if (!busy) onSignIn(email, password)
                        }),
                        modifier = Modifier.fillMaxWidth(),
                    )

                    Spacer(Modifier.height(10.dp))
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(
                                checked = remember,
                                onCheckedChange = { remember = it },
                                colors = CheckboxDefaults.colors(
                                    checkedColor = GreenDeep,
                                    uncheckedColor = InkSoft,
                                    checkmarkColor = Color.White,
                                ),
                            )
                            Text("Stay signed in", color = Ink, fontSize = 13.sp)
                        }
                        TextButton(onClick = { onPlaceholder("Resetting your own password") }) {
                            Text("Forgot password?", color = Color(0xFF57C7FF), fontSize = 13.sp)
                        }
                    }

                    Spacer(Modifier.height(6.dp))
                    Button(
                        onClick = { focus.clearFocus(); onSignIn(email, password) },
                        enabled = !busy && email.isNotBlank() && password.isNotBlank(),
                        shape = RoundedCornerShape(12.dp),
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = Color.Transparent,
                            disabledContainerColor = Color.Transparent,
                        ),
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(52.dp),
                    ) {
                        Box(
                            Modifier
                                .fillMaxSize()
                                .background(
                                    Brush.linearGradient(listOf(Color(0xFF2FB83A), GreenDeep)),
                                    RoundedCornerShape(12.dp),
                                ),
                            contentAlignment = Alignment.Center,
                        ) {
                            if (busy) {
                                CircularProgressIndicator(
                                    color = Color.White,
                                    strokeWidth = 2.2.dp,
                                    modifier = Modifier.size(21.dp),
                                )
                            } else {
                                Text(
                                    "Sign In  →",
                                    color = Color.White,
                                    fontSize = 15.sp,
                                    fontWeight = FontWeight.Bold,
                                )
                            }
                        }
                    }

                    Spacer(Modifier.height(10.dp))
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.Center,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("New to StreetSweep? ", color = InkSoft, fontSize = 12.5.sp)
                        Text(
                            "Create an account",
                            color = Color(0xFF57C7FF),
                            fontSize = 12.5.sp,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.clickable { onPlaceholder("Signing yourself up") },
                        )
                    }

                    Spacer(Modifier.height(10.dp))
                    if (editingServer) {
                        OutlinedTextField(
                            value = serverField,
                            onValueChange = { serverField = it },
                            placeholder = { Text("streetsweep.example.com", color = InkSoft) },
                            singleLine = true,
                            enabled = !busy,
                            shape = RoundedCornerShape(12.dp),
                            colors = fieldColours(),
                            keyboardOptions = KeyboardOptions(
                                keyboardType = KeyboardType.Uri,
                                imeAction = ImeAction.Done,
                            ),
                            keyboardActions = KeyboardActions(onDone = {
                                focus.clearFocus(); onChangeServer(serverField); editingServer = false
                            }),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.End,
                        ) {
                            TextButton(onClick = { serverField = serverLabel; editingServer = false }) {
                                Text("Cancel", color = InkSoft, fontSize = 12.5.sp)
                            }
                            TextButton(onClick = {
                                focus.clearFocus(); onChangeServer(serverField); editingServer = false
                            }) {
                                Text("Use this server", color = Color(0xFF57C7FF), fontSize = 12.5.sp)
                            }
                        }
                    } else {
                        // Worth stating which server this is, and the natural place to change it.
                        Text(
                            "Signing in to $serverLabel  ·  Change",
                            color = InkSoft,
                            fontSize = 11.5.sp,
                            textAlign = TextAlign.Center,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { editingServer = true },
                        )
                    }
                }
            }

            if (onSkip != null) {
                Spacer(Modifier.height(10.dp))
                TextButton(onClick = onSkip) {
                    Text("Keep using it on this phone only", color = InkSoft, fontSize = 13.sp)
                }
            }

            Spacer(Modifier.height(22.dp))
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly,
            ) {
                Use(R.drawable.use_track, "Track\nYour Drives")
                Use(R.drawable.use_progress, "See Your\nProgress")
                Use(R.drawable.use_complete, "Complete\nEvery Street")
            }
            Spacer(Modifier.height(16.dp))
        }
    }
}

@Composable
private fun Use(icon: Int, label: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        // Image rather than Icon: these are the brand's own artwork and carry their
        // colour, which a tint would flatten.
        Image(
            painterResource(icon),
            contentDescription = null,
            modifier = Modifier.height(22.dp),
        )
        Spacer(Modifier.height(6.dp))
        Text(
            label,
            color = InkSoft,
            fontSize = 11.5.sp,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            lineHeight = 15.sp,
        )
    }
}

@Composable
private fun fieldColours() = OutlinedTextFieldDefaults.colors(
    focusedTextColor = Ink,
    unfocusedTextColor = Ink,
    disabledTextColor = InkSoft,
    focusedContainerColor = FieldFill,
    unfocusedContainerColor = FieldFill,
    disabledContainerColor = FieldFill,
    focusedBorderColor = GreenDeep,
    unfocusedBorderColor = LineSoft,
    disabledBorderColor = LineSoft,
    cursorColor = GreenBright,
)

/**
 * The backdrop: a few streets, four of them finished and glowing. Drawn in fractions of
 * the canvas so it fills any handset without a second asset.
 */
private fun Modifier.nightMap(): Modifier = drawBehind {
    val w = size.width
    val h = size.height

    drawRect(
        Brush.radialGradient(
            colors = listOf(NavyLift, Navy950),
            center = Offset(w * 0.18f, h * 0.08f),
            radius = maxOf(w, h) * 0.95f,
        ),
    )

    fun road(points: List<Offset>, colour: Color, width: Float, glow: Boolean) {
        val path = Path().apply {
            moveTo(points.first().x, points.first().y)
            for (i in 1 until points.size) lineTo(points[i].x, points[i].y)
        }
        if (glow) {
            drawPath(path, colour.copy(alpha = 0.22f), style = Stroke(width * 4f, cap = StrokeCap.Round))
            drawPath(path, colour.copy(alpha = 0.34f), style = Stroke(width * 2.1f, cap = StrokeCap.Round))
        }
        drawPath(path, colour, style = Stroke(width, cap = StrokeCap.Round))
    }

    // The grid that is still waiting. Faint: this is a backdrop, not a diagram.
    val grid = RoadDim.copy(alpha = 0.55f)
    for (f in listOf(0.06f, 0.14f, 0.80f, 0.88f, 0.95f)) {
        road(listOf(Offset(0f, h * f), Offset(w, h * f)), grid, 2f, false)
    }
    for (f in listOf(0.17f, 0.42f, 0.68f, 0.88f)) {
        road(listOf(Offset(w * f, 0f), Offset(w * f, h)), grid, 2f, false)
    }

    // What has been swept, kept to the top and bottom bands so nothing cuts across the
    // card in the middle, where it would fight the text sitting on top of it.
    road(
        listOf(Offset(0f, h * 0.14f), Offset(w * 0.42f, h * 0.14f), Offset(w * 0.42f, h * 0.06f), Offset(w, h * 0.06f)),
        GreenBright.copy(alpha = 0.85f), 3f, true,
    )
    road(
        listOf(Offset(w * 0.17f, h * 0.80f), Offset(w * 0.68f, h * 0.80f), Offset(w * 0.68f, h * 0.95f), Offset(w, h * 0.95f)),
        GreenBright.copy(alpha = 0.85f), 3f, true,
    )

    // Places marked along the way, in those same bands.
    for (p in listOf(
        Offset(w * 0.42f, h * 0.14f),
        Offset(w * 0.17f, h * 0.80f),
        Offset(w * 0.68f, h * 0.80f),
        Offset(w * 0.88f, h * 0.95f),
    )) {
        drawCircle(GreenBright.copy(alpha = 0.20f), radius = 16f, center = p)
        drawCircle(GreenBright.copy(alpha = 0.9f), radius = 7f, center = p)
    }

    // A scrim so the card reads against whatever is behind it.
    drawRect(
        Brush.verticalGradient(
            0.00f to Navy950.copy(alpha = 0.10f),
            0.22f to Navy950.copy(alpha = 0.72f),
            0.70f to Navy950.copy(alpha = 0.72f),
            1.00f to Navy950.copy(alpha = 0.15f),
        ),
    )
}
