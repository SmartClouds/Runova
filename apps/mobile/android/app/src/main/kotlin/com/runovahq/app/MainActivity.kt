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
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.view.WindowManager
import uniffi.runova_ffi.BiometricRequestView
import uniffi.runova_ffi.Engine
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.ui.AccountIntents
import com.runovahq.app.ui.AppIntents
import com.runovahq.app.ui.AppRoot
import com.runovahq.app.ui.DeployIntents
import com.runovahq.app.ui.GitIntents
import com.runovahq.app.ui.NotificationIntents
import com.runovahq.app.ui.tabFor
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import android.Manifest
import uniffi.runova_ffi.notificationDestination
import com.runovahq.app.ui.MonitoringIntents
import com.runovahq.app.ui.PipelineIntents
import com.runovahq.app.ui.RemoteFrames
import com.runovahq.app.ui.RemoteIntents
import com.runovahq.app.ui.StatusIntents
import com.runovahq.app.ui.PromptIntents
import com.runovahq.app.ui.StudioIntents
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
            finishIntro = { engine.introDone() },
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
                openTags = { engine.gitOpenTags() },
                closeTags = { engine.gitCloseTags() },
                suggestTag = { engine.gitSuggestTag() },
                createTag = { tag, message, push -> engine.gitCreateTag(tag, message, push) },
                suggestCommit = { engine.gitSuggestCommitMessage() },
                suggestBranch = { engine.gitSuggestBranchName() },
                aiTaken = { engine.gitAiTaken() },
                cancelAi = { engine.gitCancelAi() },
                resolveWithAi = { engine.gitResolveWithAi(it) },
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
            deploy = DeployIntents(
                openServer = { engine.deployOpenServer(it) },
                closeServer = { engine.deployCloseServer() },
                openLogs = { engine.deployOpenLogs(it) },
                closeLogs = { engine.deployCloseLogs() },
                containerAction = { id, action -> engine.deployContainerAction(id, action) },
                stackAction = { stack, action -> engine.deployStackAction(stack, action) },
                redeploy = { engine.deployStackRedeploy(it) },
            ),
            monitoring = MonitoringIntents(
                open = { engine.monitorOpen(it) },
                close = { engine.monitorClose() },
                check = { engine.monitorCheck(it) },
                setPaused = { id, source, paused -> engine.monitorSetPaused(id, source, paused) },
                openErrors = { engine.errorsOpen() },
                closeErrors = { engine.errorsClose() },
                openIssue = { connection, issue -> engine.errorsOpenIssue(connection, issue) },
                closeIssue = { engine.errorsCloseIssue() },
                resolveIssue = { engine.errorsResolve() },
                reopenIssue = { engine.errorsReopen() },
            ),
            pipelines = PipelineIntents(
                openRun = { engine.pipelinesOpenRun(it) },
                closeRun = { engine.pipelinesCloseRun() },
                openJob = { engine.pipelinesOpenJob(it) },
                closeJob = { engine.pipelinesCloseJob() },
                dispatch = { engine.pipelinesDispatch(it) },
                submitDispatch = { engine.pipelinesSubmitDispatch(it) },
                closeDispatch = { engine.pipelinesCloseDispatch() },
                cancel = { engine.pipelinesCancel(it) },
                fixWithAi = { engine.pipelinesFixWithAi(it) },
                autoFixStart = { engine.autoFixStart(it) },
                autoFixStop = { engine.autoFixStop(it) },
                autoFixRetry = { engine.autoFixRetry(it) },
                autoFixCommit = { engine.autoFixCommit(it) },
                autoFixDismiss = { engine.autoFixDismiss(it) },
                watchAgent = { core.openTerminal(it) },
            ),
            account = AccountIntents(
                setName = { engine.accountSetName(it) },
                endSession = { engine.accountEndSession(it) },
                endOtherSessions = { engine.accountEndOtherSessions() },
                submitStepUp = { password, code -> engine.accountSubmitStepUp(password, code) },
                cancelStepUp = { engine.accountCancelStepUp() },
                openTeam = { engine.accountOpenTeam(it) },
                closeTeam = { engine.accountCloseTeam() },
                invite = { email, role -> engine.accountInvite(email, role) },
                cancelInvitation = { engine.accountCancelInvitation(it) },
                removeMember = { engine.accountRemoveMember(it) },
                setMemberRole = { id, role -> engine.accountSetMemberRole(id, role) },
                acceptInvitation = { engine.accountAcceptInvitation(it) },
                declineInvitation = { engine.accountDeclineInvitation(it) },
            ),
            forgetThisPhone = { engine.forgetThisPhone() },
            notifications = NotificationIntents(
                open = { engine.notificationOpen(it) },
                dismissBanner = { engine.notificationDismissBanner() },
                markAllRead = { engine.notificationsMarkAllRead() },
                openSettings = { engine.notificationsOpenSettings() },
                closeSettings = { engine.notificationsCloseSettings() },
                setEnabled = { category, on -> engine.notificationSetEnabled(category, on) },
            ),
            remote = remoteIntents(),
            prompts = PromptIntents(
                generate = { request, type, target -> engine.promptsGenerate(request, type, target) },
                cancel = { engine.promptsCancel() },
                taken = { engine.promptsTaken() },
                send = { prompt, cli -> engine.promptsSend(prompt, cli) },
            ),
            studio = StudioIntents(
                openComposer = { engine.studioOpenComposer() },
                closeComposer = { engine.studioCloseComposer() },
                create = { brief, aspect, language, seconds, style -> engine.studioCreate(brief, aspect, language, seconds, style) },
                openVideo = { engine.studioOpenVideo(it) },
                closeVideo = { engine.studioCloseVideo() },
                ask = { engine.studioAsk(it) },
                applyProposal = { engine.studioApplyProposal() },
                discardProposal = { engine.studioDiscardProposal() },
                undo = { engine.studioUndo() },
                animate = { engine.studioAnimate(it) },
                animateAll = { engine.studioAnimateAll() },
                cancelRun = { engine.studioCancelRun() },
                openRender = { engine.studioOpenRender() },
                closeRender = { engine.studioCloseRender() },
                render = { engine.studioRender(it) },
                cancelRender = { engine.studioCancelRender(it) },
                thumbnail = { engine.studioThumbnail(it) },
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
        handlePushTap(intent)
        startPush()
    }

    private val frames = RemoteFrames()

    private fun remoteIntents() = RemoteIntents(
        frames = frames,
        open = { engine.remoteOpen(it, frames) },
        close = { engine.remoteClose() },
        submitPassword = { engine.remoteSubmitPassword(it) },
        usePassword = { engine.remoteUsePassword() },
        pointer = { engine.remotePointer(it) },
        text = { engine.remoteText(it) },
        key = { engine.remoteKey(it) },
        sendClipboard = {
            val text = clipboard().primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)
            engine.remoteSendClipboard(text?.toString().orEmpty())
        },
        copyClipboard = {
            clipboard().setPrimaryClip(ClipData.newPlainText("Runova", it))
            engine.remoteClipboardTaken()
        },
        clipboardTaken = { engine.remoteClipboardTaken() },
        dismissNote = { engine.remoteDismissNote() },
    )

    private fun clipboard() = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleCallback(intent)
        handlePushTap(intent)
    }

    /** Asks the OS for a push token. Does nothing until the app is built with a Firebase project. */
    private fun startPush() {
        if (BuildConfig.FIREBASE_API_KEY.isEmpty()) return
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        if (FirebaseApp.getApps(this).isEmpty()) {
            FirebaseApp.initializeApp(
                this,
                FirebaseOptions.Builder()
                    .setApiKey(BuildConfig.FIREBASE_API_KEY)
                    .setApplicationId(BuildConfig.FIREBASE_APP_ID)
                    .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
                    .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID)
                    .build(),
            )
        }
        FirebaseMessaging.getInstance().token.addOnSuccessListener { engine.registerPushToken(it) }
    }

    /** A tapped push arrives as this activity's extras, with what the server put in `data`. */
    private fun handlePushTap(intent: Intent) {
        val category = intent.getStringExtra("category") ?: return
        intent.getStringExtra("notificationId")?.toLongOrNull()?.let { engine.notificationOpen(it) }
        tab = tabFor(notificationDestination(category), view?.connection != null)
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
