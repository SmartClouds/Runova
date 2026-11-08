package com.runovahq.app

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.fragment.app.FragmentActivity
import android.view.WindowManager
import uniffi.runova_ffi.BiometricRequestView
import uniffi.runova_ffi.Engine
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.ui.AppIntents
import com.runovahq.app.ui.AppRoot
import com.runovahq.app.ui.GitIntents
import com.runovahq.app.ui.StatusIntents
import com.runovahq.app.ui.VaultIntents
import com.runovahq.app.ui.StartingScreen
import uniffi.runova_ffi.AppLifecycle
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.CoreConfig
import uniffi.runova_ffi.RunovaCore
import uniffi.runova_ffi.ViewListener

private const val SITE = "https://runovahq.com"
private const val BACKGROUND_GRACE_MS = 30_000uL

class MainActivity : FragmentActivity(), ViewListener {
    private val main = Handler(Looper.getMainLooper())
    private var view by mutableStateOf<AppView?>(null)
    private var tab by mutableStateOf("systems")
    private lateinit var core: RunovaCore
    private lateinit var engine: Engine
    private var lastBiometric = 0uL

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        core = RunovaCore(
            CoreConfig(site = SITE, platform = "android", appVersion = BuildConfig.VERSION_NAME),
            AndroidSecureStore(applicationContext),
            this,
        )
        engine = core.engine()
        val intents = AppIntents(
            signIn = ::openSignIn,
            refresh = { core.refresh() },
            connect = { core.connect(it) },
            disconnect = { core.disconnect() },
            signOut = { core.signOut() },
            openSection = { core.openSection(it) },
            selectProject = { core.selectProject(it) },
            openTerminal = { core.openTerminal(it) },
            closeTerminal = { core.closeTerminal() },
            terminalInput = { core.terminalInput(it) },
            terminalScroll = { core.terminalScroll(it) },
            loadProcesses = { core.loadTerminalProcesses(it) },
            confirm = { engine.confirm() },
            dismissConfirm = { engine.dismissConfirm() },
            dismissNotice = { engine.dismissNotice() },
            git = GitIntents(
                openDiff = { path, group -> engine.openGitDiff(path, group) },
                closeDiff = { engine.closeGitDiff() },
                openBranches = { engine.openGitBranches() },
                closeBranches = { engine.closeGitBranches() },
                stage = { engine.gitStage(it) },
                unstage = { engine.gitUnstage(it) },
                discard = { path, group -> engine.gitDiscard(path, group) },
                commit = { message, push -> engine.gitCommit(message, push) },
                fetch = { engine.gitFetch() },
                pull = { engine.gitPull() },
                push = { engine.gitPush() },
                checkout = { engine.gitCheckout(it) },
                createBranch = { engine.gitCreateBranch(it) },
                deleteBranch = { engine.gitDeleteBranch(it) },
                stashPush = { engine.gitStashPush(it) },
                stashPop = { engine.gitStashPop(it) },
                stashDrop = { engine.gitStashDrop(it) },
                resolve = { path, pick -> engine.gitResolve(path, pick) },
                abort = { engine.gitAbort() },
            ),
            status = StatusIntents(
                openProvider = { engine.openUsageProvider(it) },
                closeProvider = { engine.closeUsageProvider() },
            ),
            vault = VaultIntents(
                unlock = { engine.vaultUnlock(it) },
                lock = { engine.vaultLock() },
                openEntry = { engine.vaultOpenEntry(it) },
                closeEntry = { engine.vaultCloseEntry() },
                requestReveal = { key, custom -> engine.vaultRequestReveal(key, custom) },
                hide = { engine.vaultHide() },
                save = { id, title, username, password -> engine.vaultSave(id, title, username, password) },
                remove = { engine.vaultRemove(it) },
            ),
        )
        setContent {
            RunovaTheme {
                Box(Modifier.fillMaxSize().systemBarsPadding()) {
                    val current = view
                    if (current == null) {
                        StartingScreen()
                    } else {
                        AppRoot(current, tab, { tab = it }, intents)
                    }
                }
            }
        }
        handleCallback(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleCallback(intent)
    }

    override fun onStart() {
        super.onStart()
        core.lifecycle(AppLifecycle.Foregrounded)
    }

    override fun onStop() {
        super.onStop()
        core.lifecycle(AppLifecycle.Backgrounded(BACKGROUND_GRACE_MS))
    }

    /** Called on the core's own threads. */
    override fun onView(view: AppView) {
        main.post {
            this.view = view
            guardVault(view)
        }
    }

    /** Keeps the Vault out of screenshots and the app switcher, and runs the phone's own check. */
    private fun guardVault(view: AppView) {
        if (view.vault.onShow) {
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
        val request = view.vault.biometric ?: return
        if (request.id != lastBiometric) {
            lastBiometric = request.id
            confirmIdentity(request)
        }
    }

    private fun confirmIdentity(request: BiometricRequestView) {
        val allowed = BIOMETRIC_WEAK or DEVICE_CREDENTIAL
        if (BiometricManager.from(this).canAuthenticate(allowed) != BiometricManager.BIOMETRIC_SUCCESS) {
            engine.biometricResult(request.id, false)
            return
        }
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                engine.biometricResult(request.id, true)
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                engine.biometricResult(request.id, false)
            }
        }
        val prompt = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Confirm it's you")
            .setSubtitle(request.reason)
            .setAllowedAuthenticators(allowed)
            .build()
        BiometricPrompt(this, mainExecutor, callback).authenticate(prompt)
    }

    private fun openSignIn() {
        val link = core.beginSignIn(Build.MODEL)
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link.url)))
    }

    private fun handleCallback(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "com.runovahq.app") core.finishSignIn(data.toString())
    }
}
