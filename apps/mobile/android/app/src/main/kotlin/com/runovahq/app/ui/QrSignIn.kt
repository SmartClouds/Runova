package com.runovahq.app.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.runovahq.app.design.ButtonKind
import com.runovahq.app.design.RunovaButton
import com.runovahq.app.design.RunovaCard
import com.runovahq.app.design.RunovaIcon
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaType
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import uniffi.runova_ffi.QrSignInView

/** The text of a QR code in a camera frame's brightness plane, or null when there is none. */
fun readQrCode(luminance: ByteArray, rowStride: Int, width: Int, height: Int): String? {
    val source = PlanarYUVLuminanceSource(luminance, rowStride, height, 0, 0, width, height, false)
    val reader = MultiFormatReader().apply {
        setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE)))
    }
    return try {
        reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text
    } catch (_: ReaderException) {
        null
    }
}

private class QrAnalyzer(private val onCode: (String) -> Unit) : ImageAnalysis.Analyzer {
    private val found = AtomicBoolean(false)

    /** One buffer for every frame, so scanning makes no garbage. */
    private var frame = ByteArray(0)

    override fun analyze(image: ImageProxy) {
        image.use {
            if (found.get()) return
            val plane = image.planes[0]
            val buffer = plane.buffer
            if (frame.size != buffer.remaining()) frame = ByteArray(buffer.remaining())
            buffer.get(frame)
            val text = readQrCode(frame, plane.rowStride, image.width, image.height) ?: return
            if (found.compareAndSet(false, true)) onCode(text)
        }
    }
}

@Composable
private fun QrCamera(onCode: (String) -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val latest by rememberUpdatedState(onCode)
    val preview = remember { PreviewView(context) }
    DisposableEffect(owner) {
        val worker = Executors.newSingleThreadExecutor()
        val main = ContextCompat.getMainExecutor(context)
        val future = ProcessCameraProvider.getInstance(context)
        var closed = false
        future.addListener({
            if (closed) return@addListener
            val shown = Preview.Builder().build().also { it.surfaceProvider = preview.surfaceProvider }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setResolutionSelector(
                    ResolutionSelector.Builder()
                        .setResolutionStrategy(
                            ResolutionStrategy(
                                android.util.Size(1280, 720),
                                ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER,
                            ),
                        )
                        .build(),
                )
                .build()
            analysis.setAnalyzer(worker, QrAnalyzer { text -> main.execute { latest(text) } })
            val provider = future.get()
            provider.unbindAll()
            provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, shown, analysis)
        }, main)
        onDispose {
            closed = true
            // The camera and its buffers go as soon as the screen does.
            if (future.isDone) future.get().unbindAll()
            worker.shutdown()
        }
    }
    AndroidView({ preview }, modifier)
}

/** The camera, with the square to hold the code in. */
@Composable
fun QrScanScreen(onCode: (String) -> Unit, onCancel: () -> Unit) {
    val context = LocalContext.current
    var allowed by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED,
        )
    }
    var refused by remember { mutableStateOf(false) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        allowed = granted
        refused = !granted
    }
    LaunchedEffect(Unit) {
        if (!allowed) ask.launch(Manifest.permission.CAMERA)
    }
    val colors = RunovaTheme.colors
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        if (allowed) QrCamera(onCode, Modifier.fillMaxSize())
        Column(
            Modifier.fillMaxSize().systemBarsPadding().padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            RunovaText("Scan to sign in", style = RunovaType.heading, color = Color.White)
            Spacer(Modifier.height(6.dp))
            RunovaText(
                if (refused) {
                    "Runova needs the camera to read the code. Allow it in the phone's settings, or sign in with the browser."
                } else {
                    "Show the code in Runova on your computer (Account, Devices) or on runovahq.com (Devices and sessions)."
                },
                color = Color.White.copy(alpha = 0.78f),
                align = TextAlign.Center,
            )
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Box(Modifier.size(248.dp).border(2.dp, colors.primary, RoundedCornerShape(20.dp)))
            }
            RunovaButton("Cancel", onClick = onCancel, modifier = Modifier.fillMaxWidth(), kind = ButtonKind.Soft)
        }
    }
}

/** After the scan: the digits both screens show, until the other side answers. */
@Composable
fun QrWaitingScreen(view: QrSignInView, onCancel: () -> Unit) {
    val colors = RunovaTheme.colors
    Column(
        Modifier.fillMaxSize().systemBarsPadding().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        RunovaLogo(72.dp)
        Spacer(Modifier.height(16.dp))
        val digits = view.matchCode
        if (digits == null) {
            RunovaText("Checking the code…", style = RunovaType.heading, align = TextAlign.Center)
        } else {
            RunovaText("Approve on your other screen", style = RunovaType.heading, align = TextAlign.Center)
            Spacer(Modifier.height(6.dp))
            RunovaText(
                "Check that it shows these digits, then approve. Only approve if they match.",
                color = colors.mutedForeground,
                align = TextAlign.Center,
            )
            Spacer(Modifier.height(20.dp))
            RunovaCard(Modifier.fillMaxWidth()) {
                RunovaText(
                    digits,
                    modifier = Modifier.fillMaxWidth(),
                    style = RunovaType.mono.copy(
                        fontSize = 40.sp,
                        lineHeight = 48.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = 0.18.em,
                    ),
                    align = TextAlign.Center,
                )
            }
        }
        Spacer(Modifier.height(24.dp))
        RunovaButton("Cancel", onClick = onCancel, modifier = Modifier.fillMaxWidth(), kind = ButtonKind.Soft)
    }
}

/** The second way in on the sign-in screen. */
@Composable
fun ScanQrButton(onClick: () -> Unit) {
    RunovaButton(
        "Scan QR code",
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        kind = ButtonKind.Soft,
        icon = RunovaIcons.QrCode,
    )
}
