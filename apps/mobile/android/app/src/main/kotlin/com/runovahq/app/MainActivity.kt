package com.runovahq.app

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import androidx.activity.compose.setContent
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.content.FileProvider
import java.io.File
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.fragment.app.FragmentActivity
import android.content.ClipData
import android.content.ClipDescription
import android.os.PersistableBundle
import android.widget.Toast
import android.content.ClipboardManager
import android.content.Context
import android.view.WindowManager
import uniffi.runova_ffi.BiometricRequestView
import uniffi.runova_ffi.Engine
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.ui.AccountIntents
import com.runovahq.app.ui.AppIntents
import com.runovahq.app.ui.AppRoot
import com.runovahq.app.ui.CloudflareIntents
import com.runovahq.app.ui.DeployIntents
import com.runovahq.app.ui.TrafficIntents
import com.runovahq.app.ui.GitIntents
import com.runovahq.app.ui.LockIntents
import com.runovahq.app.ui.PasscodeIntents
import com.runovahq.app.ui.PhraseIntents
import com.runovahq.app.ui.ReceiveIntents
import com.runovahq.app.ui.SendIntents
import com.runovahq.app.ui.SendPicks
import com.runovahq.app.ui.StagedFile
import com.runovahq.app.ui.NotificationIntents
import com.runovahq.app.ui.tabFor
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
import uniffi.runova_ffi.PickedFile
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
    private var lastUnlockPrompt = 0uL
    private var pendingConnect: Long? = null
    private val askLocalNetwork = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        pendingConnect?.let { core.connect(it) }
        pendingConnect = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        core = RunovaCore(
            CoreConfig(site = SITE, platform = "android", appVersion = BuildConfig.VERSION_NAME),
            AndroidSecureStore(applicationContext),
            this,
        )
        engine = core.engine()
        // Files computers send to the phone go to a folder of the app's own (E114).
        engine.setReceiveFolder(receivedFolder().absolutePath)
        val intents = AppIntents(
            signIn = ::openSignIn,
            refresh = { core.refresh() },
            connect = ::connect,
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
            scanSignIn = { engine.scanSignIn(it) },
            cancelQrSignIn = { engine.cancelQrSignIn() },
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
                deleteTag = { engine.gitDeleteTag(it) },
                openPr = { engine.gitOpenPr() },
                closePr = { engine.gitClosePr() },
                suggestPr = { engine.gitSuggestPr() },
                prSuggestionTaken = { engine.gitPrSuggestionTaken() },
                createPr = { title, body, draft -> engine.gitCreatePr(title, body, draft) },
                reviewPr = { engine.gitReviewPr() },
                prReviewTaken = { engine.gitPrReviewTaken() },
                postReview = { engine.gitPostReview(it) },
                cancelPrAi = { engine.gitCancelPrAi() },
                applyVersion = { engine.gitApplyVersion(it) },
                cancelVersion = { engine.gitCancelVersion() },
                versionToggle = { engine.gitVersionToggle(it) },
                closeVersion = { engine.gitCloseVersion() },
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
                traffic = TrafficIntents(
                    open = { engine.deployOpenTraffic() },
                    close = { engine.trafficClose() },
                    setTab = { engine.trafficSetTab(it) },
                    setRange = { engine.trafficSetRange(it) },
                    setSite = { engine.trafficSetSite(it) },
                    setGranularity = { engine.trafficSetGranularity(it) },
                    block = { engine.trafficBlock(it) },
                    unblock = { engine.trafficUnblock(it) },
                    openSettings = { engine.trafficOpenSettings() },
                    closeSettings = { engine.trafficCloseSettings() },
                    setStatistics = { engine.trafficSettingsStatistics(it) },
                    setCountries = { engine.trafficSettingsCountries(it) },
                    setHourly = { engine.trafficSettingsHourly(it) },
                    setDaily = { engine.trafficSettingsDaily(it) },
                    setDetection = { engine.trafficSettingsDetection(it) },
                    saveSettings = { engine.trafficSettingsSave() },
                    openDimension = { engine.trafficOpenDimension(it) },
                    moreDimension = { engine.trafficDimensionMore() },
                    closeDimension = { engine.trafficCloseDimension() },
                ),
            ),
            cloudflare = CloudflareIntents(
                openZone = { engine.cloudflareOpenZone(it) },
                closeZone = { engine.cloudflareCloseZone() },
                setDevMode = { engine.cloudflareSetDevMode(it) },
                setUnderAttack = { engine.cloudflareSetUnderAttack(it) },
                setAiBotsBlocked = { engine.cloudflareSetAiBotsBlocked(it) },
                newRecord = { engine.cloudflareNewRecord() },
                editRecord = { engine.cloudflareEditRecord(it) },
                closeRecordForm = { engine.cloudflareCloseRecordForm() },
                saveRecord = { engine.cloudflareSaveRecord(it) },
                setProxied = { id, on -> engine.cloudflareSetProxied(id, on) },
                deleteRecord = { engine.cloudflareDeleteRecord(it) },
                openTokenForm = { engine.cloudflareOpenTokenForm(it) },
                closeTokenForm = { engine.cloudflareCloseTokenForm() },
                saveToken = { token, label -> engine.cloudflareSaveToken(token, label) },
                checkToken = { engine.cloudflareCheckToken(it) },
                removeToken = { engine.cloudflareRemoveToken(it) },
                openAddDomain = { engine.cloudflareOpenAddDomain(it) },
                closeAddDomain = { engine.cloudflareCloseAddDomain() },
                addDomain = { name, account -> engine.cloudflareAddDomain(name, account) },
                checkActivation = { engine.cloudflareCheckActivation() },
                openPointDomain = { engine.cloudflareOpenPointDomain() },
                closePointDomain = { engine.cloudflareClosePointDomain() },
                previewPointDomain = { name, server, www, proxied -> engine.cloudflarePreviewPointDomain(name, server, www, proxied) },
                applyPointDomain = { engine.cloudflareApplyPointDomain() },
                openTab = { engine.cloudflareOpenTab(it) },
                changeSetting = { key, value -> engine.cloudflareChangeSetting(key, value) },
                setRuleEnabled = { id, on -> engine.cloudflareSetRuleEnabled(id, on) },
                deleteRule = { engine.cloudflareDeleteRule(it) },
                openRuleBuilder = { engine.cloudflareOpenRuleBuilder() },
                closeRuleBuilder = { engine.cloudflareCloseRuleBuilder() },
                addRule = { kind, values, path, prefix, description -> engine.cloudflareAddRule(kind, values, path, prefix, description) },
                openAccessRuleForm = { engine.cloudflareOpenAccessRuleForm() },
                closeAccessRuleForm = { engine.cloudflareCloseAccessRuleForm() },
                addAccessRule = { value, mode, notes -> engine.cloudflareAddAccessRule(value, mode, notes) },
                deleteAccessRule = { engine.cloudflareDeleteAccessRule(it) },
                purgeEverything = { engine.cloudflarePurgeEverything() },
                purgeUrls = { engine.cloudflarePurgeUrls(it) },
                gatePrepare = { engine.cloudflareGatePrepare(it) },
                gateSwitch = { host, on -> engine.cloudflareGateSwitch(host, on) },
                gateEdit = { engine.cloudflareGateEdit(it) },
                gateClose = { engine.cloudflareGateClose() },
                gateAddPeople = { engine.cloudflareGateAddPeople(it) },
                gateRemovePerson = { value, domain -> engine.cloudflareGateRemovePerson(value, domain) },
                gateSetSession = { engine.cloudflareGateSetSession(it) },
                gateSave = { engine.cloudflareGateSave() },
                gateTurnOff = { engine.cloudflareGateTurnOff(it) },
                gateProxy = { engine.cloudflareGateProxy(it) },
                gateLetThrough = { engine.cloudflareGateLetThrough(it) },
                openIpLimit = { engine.cloudflareOpenIpLimit(it) },
                closeIpLimit = { engine.cloudflareCloseIpLimit() },
                ipLimitSetName = { engine.cloudflareIpLimitSetName(it) },
                ipLimitSetScope = { engine.cloudflareIpLimitSetScope(it) },
                ipLimitSetPath = { engine.cloudflareIpLimitSetPath(it) },
                ipLimitSetPrefix = { engine.cloudflareIpLimitSetPrefix(it) },
                ipLimitAddAddresses = { engine.cloudflareIpLimitAddAddresses(it) },
                ipLimitRemoveAddress = { engine.cloudflareIpLimitRemoveAddress(it) },
                ipLimitAddThisComputer = { engine.cloudflareIpLimitAddThisComputer() },
                ipLimitSave = { engine.cloudflareIpLimitSave() },
                ipLimitSetEnabled = { id, on -> engine.cloudflareIpLimitSetEnabled(id, on) },
                ipLimitDelete = { engine.cloudflareIpLimitDelete(it) },
                newWidget = { engine.cloudflareNewWidget() },
                editWidget = { engine.cloudflareEditWidget(it) },
                closeWidgetForm = { engine.cloudflareCloseWidgetForm() },
                saveWidget = { engine.cloudflareSaveWidget(it) },
                deleteWidget = { engine.cloudflareDeleteWidget(it) },
                revealSecret = { engine.cloudflareRevealSecret(it) },
                hideSecret = { engine.cloudflareHideSecret() },
                rotateSecret = { key, now -> engine.cloudflareRotateSecret(key, now) },
                dnsTokenMint = { engine.cloudflareDnsTokenMint(it) },
                dnsTokenPaste = { server, token -> engine.cloudflareDnsTokenPaste(server, token) },
                dnsTokenRemove = { engine.cloudflareDnsTokenRemove(it) },
                openOrigin = { engine.cloudflareOpenOrigin(it) },
                closeOrigin = { engine.cloudflareCloseOrigin() },
                originMode = { engine.cloudflareOriginMode(it) },
                closeOriginDialog = { engine.cloudflareCloseOriginDialog() },
                originApply = { engine.cloudflareOriginApply() },
                lockOpen = { engine.cloudflareLockOpen(it) },
                lockSetAop = { engine.cloudflareLockSetAop(it) },
                tunnelSetupOpen = { engine.cloudflareTunnelSetupOpen() },
                tunnelSetupAccount = { engine.cloudflareTunnelSetupAccount(it) },
                tunnelSetupSsh = { route, name -> engine.cloudflareTunnelSetupSsh(route, name) },
                tunnelSetupAck = { engine.cloudflareTunnelSetupAck(it) },
                tunnelPortsOpen = { engine.cloudflareTunnelPortsOpen() },
                tunnelSshOpen = { engine.cloudflareTunnelSshOpen() },
                tunnelSshMode = { engine.cloudflareTunnelSshMode(it) },
                tunnelSshTest = { engine.cloudflareTunnelSshTest() },
                tunnelJoinMesh = { engine.cloudflareTunnelJoinMesh() },
                tunnelSshApply = { phrase, password -> engine.cloudflareTunnelSshApply(phrase, password) },
                tunnelOffOpen = { engine.cloudflareTunnelOffOpen() },
                tunnelOffReopen = { engine.cloudflareTunnelOffReopen(it) },
                tunnelOffPointBack = { engine.cloudflareTunnelOffPointBack(it) },
                tunnelBreakGlass = { on, minutes -> engine.cloudflareTunnelBreakGlass(on, minutes) },
                firewallKeep = { engine.cloudflareFirewallKeep() },
                firewallRevert = { engine.cloudflareFirewallRevert() },
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
                fixWithAi = { id, cli, model, effort -> engine.pipelinesFixWithAi(id, cli, model, effort) },
                autoFixStart = { id, cli, model, effort -> engine.autoFixStart(id, cli, model, effort) },
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
                setEncryption = { item, on -> engine.setEncryption(item, on) },
                acceptInvitation = { engine.accountAcceptInvitation(it) },
                declineInvitation = { engine.accountDeclineInvitation(it) },
            ),
            forgetThisPhone = { engine.forgetThisPhone() },
            lock = LockIntents(
                key = { engine.lockKey(it.toUByte()) },
                backspace = { engine.lockBackspace() },
                submit = { engine.lockSubmit(it) },
                useBiometric = { engine.lockUseBiometric() },
                forgot = { engine.lockForgot() },
                forgotConfirm = { engine.lockForgotConfirm(it) },
            ),
            phrases = PhraseIntents(
                scan = { engine.phraseScan(it) },
                reveal = { engine.phraseReveal(it) },
                hide = { engine.phraseHide() },
                delete = { engine.phraseDelete(it) },
                deleteAnswer = { engine.phraseDeleteAnswer(it) },
                unlockVault = { engine.phraseUnlockVault(it) },
                copy = { copySensitive(it) },
                save = { name, text -> savePhrase(name, text) },
            ),
            passcode = PasscodeIntents(
                open = { engine.passcodeOpen() },
                close = { engine.passcodeClose() },
                start = { engine.passcodeStart(it) },
                key = { engine.passcodeKey(it.toUByte()) },
                backspace = { engine.passcodeBackspace() },
                submit = { engine.passcodeSubmit(it) },
                off = { engine.passcodeOff() },
                setAutoLock = { engine.setAutoLock(it) },
                setBiometric = { engine.setBiometricUnlock(it) },
                lockNow = { engine.lockNow() },
            ),
            notifications = NotificationIntents(
                open = { engine.notificationOpen(it) },
                dismissBanner = { engine.notificationDismissBanner() },
                markAllRead = { engine.notificationsMarkAllRead() },
                openSettings = { engine.notificationsOpenSettings() },
                closeSettings = { engine.notificationsCloseSettings() },
                setEnabled = { category, on -> engine.notificationSetEnabled(category, on) },
            ),
            remote = remoteIntents(),
            send = sendIntents(),
            receive = receiveIntents(),
            prompts = PromptIntents(
                generate = { request, type, target -> engine.promptsGenerate(request, type, target) },
                cancel = { engine.promptsCancel() },
                taken = { engine.promptsTaken() },
                send = { prompt, cli, model, effort -> engine.promptsSend(prompt, cli, model, effort) },
                loadLibrary = { engine.promptsLoadLibrary(it) },
                saveTemplate = { name, type, target, content -> engine.promptsSaveTemplate(name, type, target, content) },
                deleteTemplate = { engine.promptsDeleteTemplate(it) },
                schedule = { engine.promptsSchedule(it) },
                cancelScheduled = { engine.promptsCancelScheduled(it) },
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
                openVoice = { engine.studioOpenVoice() },
                closeVoice = { engine.studioCloseVoice() },
                pickEngine = { engine.studioVoicePickEngine(it) },
                pickVoice = { engine.studioVoicePick(it) },
                speak = { engine.studioSpeak() },
                cancelSpeak = { engine.studioCancelSpeak() },
                caption = { engine.studioCaptionScene(it) },
                openTimeline = { engine.studioOpenTimeline() },
                closeTimeline = { engine.studioCloseTimeline() },
                nudge = { clip, seconds -> engine.studioClipNudge(clip, seconds) },
                trim = { clip, end, seconds -> engine.studioClipTrim(clip, end, seconds) },
                gain = { clip, value -> engine.studioClipGain(clip, value) },
                fades = { clip, seconds -> engine.studioClipFades(clip, seconds) },
                removeClip = { engine.studioClipRemove(it) },
                addMusic = { engine.studioAddMusic(it) },
                muteTrack = { track, muted -> engine.studioTrackMute(track, muted) },
                download = { engine.studioDownload(it, videosFolder()) },
                downloadStop = { engine.studioDownloadStop() },
                downloadDismiss = { engine.studioDownloadDismiss() },
                shareVideo = ::shareVideo,
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
        handleShare(intent)
        startPush()
    }

    // Sending files (E113): the pickers stage what to send, and the core reads it as it goes.
    private val picked by lazy { PickedUris(contentResolver) }
    private val sendPicks = SendPicks()
    private val background = java.util.concurrent.Executors.newSingleThreadExecutor()

    private fun staged(files: () -> List<StagedFile>) {
        background.execute {
            val found = files()
            main.post {
                sendPicks.add(found)
                sendPicks.open = true
            }
        }
    }

    private val pickDocuments = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) staged { picked.stageDocuments(uris) }
    }
    private val pickMedia = registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris ->
        if (uris.isNotEmpty()) staged { picked.stageDocuments(uris) }
    }
    private val pickFolder = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { tree ->
        if (tree != null) staged { picked.stageFolder(tree) }
    }

    private fun sendIntents() = SendIntents(
        picks = sendPicks,
        pickFiles = { pickDocuments.launch(arrayOf("*/*")) },
        pickPhotos = { pickMedia.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) },
        pickFolder = { pickFolder.launch(null) },
        send = { system, files, note ->
            engine.sendFiles(system, files.map { PickedFile(it.handle, it.path, it.size.toULong()) }, note, picked)
        },
        cancel = { engine.cancelSend(it) },
        retry = { engine.retrySend(it) },
        dismiss = { engine.dismissSend(it) },
        clearFinished = { engine.clearFinishedSends() },
        dismissError = { engine.dismissSendError() },
    )

    private fun receiveIntents() = ReceiveIntents(
        answer = { id, yes -> engine.answerOffer(id, yes) },
        cancel = { engine.cancelReceive(it) },
        dismiss = { engine.dismissReceived(it) },
        clear = { engine.clearReceived() },
        setEnabled = { engine.setReceiveEnabled(it) },
        setAutoAccept = { engine.setReceiveAutoAccept(it) },
        open = ::openReceived,
        share = ::shareReceived,
    )

    private fun receivedFolder(): File =
        File(getExternalFilesDir(null) ?: filesDir, "Received").apply { mkdirs() }

    private fun receivedUri(path: String): Pair<Uri, String> {
        val file = File(path)
        val type = android.webkit.MimeTypeMap.getSingleton()
            .getMimeTypeFromExtension(file.extension.lowercase()) ?: "application/octet-stream"
        return FileProvider.getUriForFile(this, "$packageName.files", file) to type
    }

    private fun openReceived(path: String) {
        val (uri, type) = runCatching { receivedUri(path) }.getOrNull() ?: return
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        runCatching { startActivity(Intent.createChooser(view, "Open with")) }
            .onFailure { Toast.makeText(this, "No app here opens this kind of file.", Toast.LENGTH_SHORT).show() }
    }

    private fun shareReceived(path: String) {
        val (uri, type) = runCatching { receivedUri(path) }.getOrNull() ?: return
        val send = Intent(Intent.ACTION_SEND).setType(type).putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        startActivity(Intent.createChooser(send, "Share or save"))
    }

    /** Files shared to Runova from another app go to the Send files screen. */
    private fun handleShare(intent: Intent?) {
        val uris = when (intent?.action) {
            Intent.ACTION_SEND -> listOfNotNull(streamOf(intent))
            Intent.ACTION_SEND_MULTIPLE -> streamsOf(intent)
            else -> return
        }
        if (uris.isNotEmpty()) staged { picked.stageDocuments(uris) }
    }

    @Suppress("DEPRECATION")
    private fun streamOf(intent: Intent): Uri? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java) else intent.getParcelableExtra(Intent.EXTRA_STREAM)

    @Suppress("DEPRECATION")
    private fun streamsOf(intent: Intent): List<Uri> =
        (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM))
            .orEmpty()

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

    /**
     * A recovery phrase on the clipboard (E108): marked sensitive so the keyboard and the clipboard
     * preview do not show it, and cleared after a minute if it is still the phrase.
     */
    private fun copySensitive(text: String) {
        val clip = ClipData.newPlainText("Recovery phrase", text)
        clip.description.extras = PersistableBundle().apply {
            putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
        }
        clipboard().setPrimaryClip(clip)
        window.decorView.postDelayed({
            val now = clipboard().primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString()
            if (now == text) clipboard().clearPrimaryClip()
        }, 60_000)
        Toast.makeText(this, "Copied. The clipboard clears in a minute.", Toast.LENGTH_SHORT).show()
    }

    private var pendingPhraseFile: String? = null

    private val createPhraseFile = registerForActivityResult(ActivityResultContracts.CreateDocument("text/plain")) { uri ->
        val text = pendingPhraseFile
        pendingPhraseFile = null
        if (uri == null || text == null) return@registerForActivityResult
        contentResolver.openOutputStream(uri, "wt")?.use { it.write(text.toByteArray()) }
        Toast.makeText(this, "Saved the recovery phrase.", Toast.LENGTH_SHORT).show()
    }

    /** Asks where to save the phrase with the system's file picker, then writes it there. */
    private fun savePhrase(fileName: String, text: String) {
        pendingPhraseFile = text
        createPhraseFile.launch(fileName)
    }

    /** The app's own folder for videos, which needs no storage permission. */
    private fun videosFolder(): String =
        (getExternalFilesDir(Environment.DIRECTORY_MOVIES) ?: filesDir).absolutePath

    private fun shareVideo(path: String) {
        val uri = FileProvider.getUriForFile(this, "$packageName.files", File(path))
        val send = Intent(Intent.ACTION_SEND)
            .setType("video/*")
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        startActivity(Intent.createChooser(send, "Share or save"))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleCallback(intent)
        handlePushTap(intent)
        handleShare(intent)
    }

    /**
     * Android 17 blocks traffic to the local network until the user allows it. Without it ICE
     * still connects, only never over the direct LAN path, so the answer doesn't stop the connect.
     */
    private fun connect(systemId: Long) {
        if (Build.VERSION.SDK_INT < 37 ||
            checkSelfPermission(Manifest.permission.ACCESS_LOCAL_NETWORK) == PackageManager.PERMISSION_GRANTED
        ) {
            core.connect(systemId)
            return
        }
        pendingConnect = systemId
        askLocalNetwork.launch(Manifest.permission.ACCESS_LOCAL_NETWORK)
    }

    /** Asks the OS for a push token. Does nothing until the app is built with a Firebase project. */
    private fun startPush() {
        if (BuildConfig.FIREBASE_API_KEY.isEmpty()) return
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        ensureFirebase(this)
        FirebaseMessaging.getInstance().token.addOnSuccessListener { engine.registerPushToken(it) }
    }

    /** A tapped push arrives as this activity's extras, with what the server put in `data`. */
    private fun handlePushTap(intent: Intent) {
        val category = intent.getStringExtra("category") ?: return
        val id = intent.getStringExtra("notificationId")?.toLongOrNull()
        // An attack's push names its server and site, and opens that site's attacks (E111).
        engine.notificationTapped(id, category, intent.getStringExtra("itemId"))
        tab = tabFor(notificationDestination(category), view?.connection != null)
    }

    override fun onStart() {
        super.onStart()
        // A finger or face may have been added while away, so the core hears this before it locks.
        val capability = BiometricEnrollment.capability(this)
        engine.setBiometricCapability(capability.kind, capability.name, capability.enrollment)
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
            guardLock(view)
            keepSending(view)
        }
    }

    /** Files going or coming keep the phone at it in the background, with the progress on show. */
    private fun keepSending(view: AppView) {
        val send = view.send
        val receive = view.receive
        when {
            send.active > 0u ->
                SendService.show(this, send.progressLabel ?: "Sending files", send.progressPercent.toInt())
            receive.active > 0u ->
                SendService.show(this, receive.progressLabel ?: "Receiving files", receive.progressPercent.toInt())
            else -> SendService.stop(this)
        }
    }

    /** Hides the app in Recents while a passcode is set, and runs the lock's own biometric check. */
    private fun guardLock(view: AppView) {
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(!view.lock.enabled)
        val request = view.lock.biometric ?: return
        if (request.id == lastUnlockPrompt) return
        lastUnlockPrompt = request.id
        // Biometrics only: the phone's own PIN must not open what the app's passcode guards.
        if (BiometricManager.from(this).canAuthenticate(BIOMETRIC_STRONG) != BiometricManager.BIOMETRIC_SUCCESS) {
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
            .setTitle("Unlock Runova")
            .setNegativeButtonText(if (view.lock.entry.length > 0u) "Use passcode" else "Use password")
            .setAllowedAuthenticators(BIOMETRIC_STRONG)
            .setConfirmationRequired(false)
            .build()
        BiometricPrompt(this, mainExecutor, callback).authenticate(prompt)
    }

    /** Keeps the Vault out of screenshots and the app switcher, and runs the phone's own check. */
    private fun guardVault(view: AppView) {
        // A Cloudflare secret on show is kept out of screenshots the same way.
        // Before Android 13 the only way to keep a locked app out of Recents is FLAG_SECURE.
        val hideLocked = view.lock.enabled && Build.VERSION.SDK_INT < 33
        val phraseShown = view.recoveryPhrases.revealed != null
        if (view.vault.onShow || view.cloudflare.revealedSecret != null || phraseShown || hideLocked) {
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
        // The same check guards a Cloudflare token pasted on the phone.
        val request = view.vault.biometric ?: view.cloudflare.biometric ?: view.recoveryPhrases.biometric ?: return
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
