import AuthenticationServices
import Security
import LocalAuthentication
import PhotosUI
import UniformTypeIdentifiers
import UserNotifications
import SwiftUI

private let service = "com.runovahq.app.secure"

/// Values kept in the iOS Keychain, readable only by this app and only after the first unlock.
final class KeychainStore: SecureStore {
    private func query(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    func get(key: String) -> String? {
        var request = query(key)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess,
            let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func set(key: String, value: String) {
        let data = Data(value.utf8)
        let update = [kSecValueData as String: data]
        if SecItemUpdate(query(key) as CFDictionary, update as CFDictionary) == errSecItemNotFound {
            var add = query(key)
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    func remove(key: String) {
        SecItemDelete(query(key) as CFDictionary)
    }
}

private let site = "https://runovahq.com"
private let backgroundGraceMs: UInt64 = 30_000

/// Holds the core and publishes what it says for SwiftUI.
@MainActor
final class AppModel: NSObject, ObservableObject {
    @Published var view: AppView?
    @Published var tab = "systems"

    private var core: RunovaCore?
    private var browser: ASWebAuthenticationSession?

    func start() {
        guard core == nil else { return }
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        let secure = KeychainStore()
        core = try? RunovaCore(
            config: CoreConfig(site: site, platform: "ios", appVersion: version),
            secure: secure,
            listener: Listener(model: self))
        core?.engine().setReceiveFolder(path: Self.receivedFolder())
        // The core makes the seed the first time, so this has to come after it.
        if let seed = secure.get(key: "identity-seed"), let secret = notificationSecret(identitySeed: seed) {
            NotificationSecret.store(secret)
        }
    }

    var intents: AppIntents {
        AppIntents(
            signIn: { [weak self] in self?.signIn() },
            refresh: { [weak self] in self?.core?.refresh() },
            connect: { [weak self] in self?.core?.connect(systemId: $0) },
            disconnect: { [weak self] in self?.core?.disconnect() },
            signOut: { [weak self] in self?.core?.signOut() },
            openSection: { [weak self] in self?.core?.openSection(section: $0) },
            selectProject: { [weak self] in self?.core?.selectProject(projectId: $0) },
            openTerminal: { [weak self] in self?.core?.openTerminal(sessionId: $0) },
            closeTerminal: { [weak self] in self?.core?.closeTerminal() },
            terminalInput: { [weak self] in self?.core?.terminalInput(data: $0) },
            terminalScroll: { [weak self] in self?.core?.terminalScroll(lines: $0) },
            loadProcesses: { [weak self] in self?.core?.loadTerminalProcesses(sessionId: $0) },
            confirm: { [weak self] in self?.engine?.confirm() },
            dismissConfirm: { [weak self] in self?.engine?.dismissConfirm() },
            dismissNotice: { [weak self] in self?.engine?.dismissNotice() },
            finishIntro: { [weak self] in self?.engine?.introDone() },
            scanSignIn: { [weak self] in self?.engine?.scanSignIn(text: $0) },
            cancelQrSignIn: { [weak self] in self?.engine?.cancelQrSignIn() },
            signInWithPasskey: { [weak self] in self?.engine?.beginPasskeySignIn() },
            promptPasskey: { [weak self] id, options in
                guard let self else { return }
                Task { @MainActor in await self.passkeyPrompt.answer(challengeId: id, optionsJson: options) }
            },
            signInWithProvider: { [weak self] in self?.engine?.beginProviderSignIn(provider: $0) },
            signInInBrowser: { [weak self] in self?.signIn(provider: $0) },
            promptApple: { [weak self] nonce in
                guard let self else { return }
                Task { @MainActor in await self.applePrompt.answer(nonce: nonce) }
            },
            git: gitIntents,
            status: StatusIntents(
                openProvider: { [weak self] in self?.engine?.openUsageProvider(providerId: $0) },
                closeProvider: { [weak self] in self?.engine?.closeUsageProvider() }),
            vault: VaultIntents(
                unlock: { [weak self] in self?.engine?.vaultUnlock(password: $0) },
                lock: { [weak self] in self?.engine?.vaultLock() },
                openEntry: { [weak self] in self?.engine?.vaultOpenEntry(id: $0) },
                closeEntry: { [weak self] in self?.engine?.vaultCloseEntry() },
                requestReveal: { [weak self] in self?.engine?.vaultRequestReveal(field: $0, custom: $1) },
                hide: { [weak self] in self?.engine?.vaultHide() },
                save: { [weak self] in self?.engine?.vaultSave(id: $0, title: $1, username: $2, password: $3) },
                remove: { [weak self] in self?.engine?.vaultRemove(id: $0) }),
            deploy: DeployIntents(
                openServer: { [weak self] in self?.engine?.deployOpenServer(id: $0) },
                closeServer: { [weak self] in self?.engine?.deployCloseServer() },
                openLogs: { [weak self] in self?.engine?.deployOpenLogs(containerId: $0) },
                closeLogs: { [weak self] in self?.engine?.deployCloseLogs() },
                containerAction: { [weak self] in self?.engine?.deployContainerAction(containerId: $0, action: $1) },
                stackAction: { [weak self] in self?.engine?.deployStackAction(stack: $0, action: $1) },
                redeploy: { [weak self] in self?.engine?.deployStackRedeploy(stack: $0) },
                traffic: TrafficIntents(
                    open: { [weak self] in self?.engine?.deployOpenTraffic() },
                    close: { [weak self] in self?.engine?.trafficClose() },
                    setTab: { [weak self] in self?.engine?.trafficSetTab(tab: $0) },
                    setRange: { [weak self] in self?.engine?.trafficSetRange(range: $0) },
                    setSite: { [weak self] in self?.engine?.trafficSetSite(siteId: $0) },
                    setGranularity: { [weak self] in self?.engine?.trafficSetGranularity(value: $0) },
                    block: { [weak self] in self?.engine?.trafficBlock(eventId: $0) },
                    unblock: { [weak self] in self?.engine?.trafficUnblock(blockId: $0) },
                    openSettings: { [weak self] in self?.engine?.trafficOpenSettings() },
                    closeSettings: { [weak self] in self?.engine?.trafficCloseSettings() },
                    setStatistics: { [weak self] in self?.engine?.trafficSettingsStatistics(on: $0) },
                    setCountries: { [weak self] in self?.engine?.trafficSettingsCountries(on: $0) },
                    setHourly: { [weak self] in self?.engine?.trafficSettingsHourly(days: $0) },
                    setDaily: { [weak self] in self?.engine?.trafficSettingsDaily(days: $0) },
                    setDetection: { [weak self] in self?.engine?.trafficSettingsDetection(on: $0) },
                    saveSettings: { [weak self] in self?.engine?.trafficSettingsSave() },
                    openDimension: { [weak self] in self?.engine?.trafficOpenDimension(dimension: $0) },
                    moreDimension: { [weak self] in self?.engine?.trafficDimensionMore() },
                    closeDimension: { [weak self] in self?.engine?.trafficCloseDimension() })),
            cloudflare: cloudflareIntents,
            monitoring: MonitoringIntents(
                open: { [weak self] in self?.engine?.monitorOpen(id: $0) },
                close: { [weak self] in self?.engine?.monitorClose() },
                check: { [weak self] in self?.engine?.monitorCheck(id: $0) },
                setPaused: { [weak self] in self?.engine?.monitorSetPaused(id: $0, source: $1, paused: $2) },
                openErrors: { [weak self] in self?.engine?.errorsOpen() },
                closeErrors: { [weak self] in self?.engine?.errorsClose() },
                openIssue: { [weak self] in self?.engine?.errorsOpenIssue(connectionId: $0, issueId: $1) },
                closeIssue: { [weak self] in self?.engine?.errorsCloseIssue() },
                resolveIssue: { [weak self] in self?.engine?.errorsResolve() },
                reopenIssue: { [weak self] in self?.engine?.errorsReopen() }),
            pipelines: PipelineIntents(
                openRun: { [weak self] in self?.engine?.pipelinesOpenRun(runId: $0) },
                closeRun: { [weak self] in self?.engine?.pipelinesCloseRun() },
                openJob: { [weak self] in self?.engine?.pipelinesOpenJob(jobId: $0) },
                closeJob: { [weak self] in self?.engine?.pipelinesCloseJob() },
                dispatch: { [weak self] in self?.engine?.pipelinesDispatch(workflowId: $0) },
                submitDispatch: { [weak self] in self?.engine?.pipelinesSubmitDispatch(values: $0) },
                closeDispatch: { [weak self] in self?.engine?.pipelinesCloseDispatch() },
                cancel: { [weak self] in self?.engine?.pipelinesCancel(runId: $0) },
                fixWithAi: { [weak self] id, cli, model, effort in
                    self?.engine?.pipelinesFixWithAi(workflowId: id, cliId: cli, model: model, effort: effort)
                },
                autoFixStart: { [weak self] id, cli, model, effort in
                    self?.engine?.autoFixStart(workflowId: id, cliId: cli, model: model, effort: effort)
                },
                autoFixStop: { [weak self] in self?.engine?.autoFixStop(id: $0) },
                autoFixRetry: { [weak self] in self?.engine?.autoFixRetry(id: $0) },
                autoFixCommit: { [weak self] in self?.engine?.autoFixCommit(id: $0) },
                autoFixDismiss: { [weak self] in self?.engine?.autoFixDismiss(id: $0) },
                watchAgent: { [weak self] in self?.core?.openTerminal(sessionId: $0) }),
            account: AccountIntents(
                setName: { [weak self] in self?.engine?.accountSetName(name: $0) },
                endSession: { [weak self] in self?.engine?.accountEndSession(id: $0) },
                endOtherSessions: { [weak self] in self?.engine?.accountEndOtherSessions() },
                submitStepUp: { [weak self] in self?.engine?.accountSubmitStepUp(password: $0, code: $1) },
                cancelStepUp: { [weak self] in self?.engine?.accountCancelStepUp() },
                openTeam: { [weak self] in self?.engine?.accountOpenTeam(id: $0) },
                closeTeam: { [weak self] in self?.engine?.accountCloseTeam() },
                invite: { [weak self] in self?.engine?.accountInvite(email: $0, role: $1) },
                cancelInvitation: { [weak self] in self?.engine?.accountCancelInvitation(id: $0) },
                removeMember: { [weak self] in self?.engine?.accountRemoveMember(userId: $0) },
                setMemberRole: { [weak self] in self?.engine?.accountSetMemberRole(userId: $0, role: $1) },
                acceptInvitation: { [weak self] in self?.engine?.accountAcceptInvitation(id: $0) },
                declineInvitation: { [weak self] in self?.engine?.accountDeclineInvitation(id: $0) },
                setEncryption: { [weak self] in self?.engine?.setEncryption(item: $0, enabled: $1) }),
            forgetThisPhone: { [weak self] in self?.engine?.forgetThisPhone() },
            lock: LockIntents(
                key: { [weak self] in self?.engine?.lockKey(digit: $0) },
                backspace: { [weak self] in self?.engine?.lockBackspace() },
                submit: { [weak self] in self?.engine?.lockSubmit(text: $0) },
                useBiometric: { [weak self] in self?.engine?.lockUseBiometric() },
                forgot: { [weak self] in self?.engine?.lockForgot() },
                forgotConfirm: { [weak self] in self?.engine?.lockForgotConfirm(signOut: $0) }),
            passcode: PasscodeIntents(
                open: { [weak self] in self?.engine?.passcodeOpen() },
                close: { [weak self] in self?.engine?.passcodeClose() },
                start: { [weak self] in self?.engine?.passcodeStart(kind: $0) },
                key: { [weak self] in self?.engine?.passcodeKey(digit: $0) },
                backspace: { [weak self] in self?.engine?.passcodeBackspace() },
                submit: { [weak self] in self?.engine?.passcodeSubmit(text: $0) },
                off: { [weak self] in self?.engine?.passcodeOff() },
                setAutoLock: { [weak self] in self?.engine?.setAutoLock(choice: $0) },
                setBiometric: { [weak self] in self?.engine?.setBiometricUnlock(on: $0) },
                lockNow: { [weak self] in self?.engine?.lockNow() }),
            phrases: PhraseIntents(
                scan: { [weak self] in self?.engine?.phraseScan(text: $0) },
                reveal: { [weak self] in self?.engine?.phraseReveal(id: $0) },
                hide: { [weak self] in self?.engine?.phraseHide() },
                delete: { [weak self] in self?.engine?.phraseDelete(id: $0) },
                deleteAnswer: { [weak self] in self?.engine?.phraseDeleteAnswer(yes: $0) },
                unlockVault: { [weak self] in self?.engine?.phraseUnlockVault(id: $0) },
                copy: { Self.copySensitive($0) },
                save: { Self.savePhrase(fileName: $0, text: $1) }),
            notifications: NotificationIntents(
                open: { [weak self] in self?.engine?.notificationOpen(id: $0) },
                dismissBanner: { [weak self] in self?.engine?.notificationDismissBanner() },
                markAllRead: { [weak self] in self?.engine?.notificationsMarkAllRead() },
                openSettings: { [weak self] in self?.engine?.notificationsOpenSettings() },
                closeSettings: { [weak self] in self?.engine?.notificationsCloseSettings() },
                setEnabled: { [weak self] in self?.engine?.notificationSetEnabled(category: $0, enabled: $1) }),
            remote: remoteIntents,
            studio: studioIntents,
            prompts: PromptIntents(
                generate: { [weak self] request, type, target in
                    self?.engine?.promptsGenerate(rawInput: request, promptType: type, target: target)
                },
                cancel: { [weak self] in self?.engine?.promptsCancel() },
                taken: { [weak self] in self?.engine?.promptsTaken() },
                send: { [weak self] prompt, cli, model, effort in
                    self?.engine?.promptsSend(prompt: prompt, cliId: cli, model: model, effort: effort)
                },
                loadLibrary: { [weak self] in self?.engine?.promptsLoadLibrary(query: $0) },
                saveTemplate: { [weak self] name, type, target, content in
                    self?.engine?.promptsSaveTemplate(name: name, promptType: type, target: target, content: content)
                },
                deleteTemplate: { [weak self] in self?.engine?.promptsDeleteTemplate(id: $0) },
                schedule: { [weak self] in self?.engine?.promptsSchedule(task: $0) },
                cancelScheduled: { [weak self] in self?.engine?.promptsCancelScheduled(id: $0) }),
            send: sendIntents,
            receive: ReceiveIntents(
                answer: { [weak self] in self?.engine?.answerOffer(id: $0, accept: $1) },
                cancel: { [weak self] in self?.engine?.cancelReceive(id: $0) },
                dismiss: { [weak self] in self?.engine?.dismissReceived(id: $0) },
                clear: { [weak self] in self?.engine?.clearReceived() },
                setEnabled: { [weak self] in self?.engine?.setReceiveEnabled(on: $0) },
                setAutoAccept: { [weak self] in self?.engine?.setReceiveAutoAccept(on: $0) }))
    }

    /// Files computers send to the phone (E114), in Documents so the Files app shows them too.
    private static func receivedFolder() -> String {
        let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Received", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.path
    }

    // Sending files (E113): the pickers stage what to send, and the core reads it as it goes.
    let sendPicks = SendPicks()
    private let picked = PickedURLs()
    private var sendTask: UIBackgroundTaskIdentifier = .invalid

    private var sendIntents: SendIntents {
        SendIntents(
            picks: sendPicks,
            stageFiles: { [weak self] urls in self?.stage { $0.stageFiles(urls) } },
            stageFolder: { [weak self] url in self?.stage { $0.stageFolder(url) } },
            stagePhotos: { [weak self] items in
                Task { @MainActor in
                    let urls = await loadPickedMedia(items)
                    self?.stage { $0.stageFiles(urls) }
                }
            },
            send: { [weak self] system, files, note in
                guard let self else { return }
                let picks = files.map { PickedFile(handle: $0.handle, path: $0.path, size: UInt64(max(0, $0.size))) }
                self.engine?.sendFiles(systemId: system, files: picks, note: note, picked: self.picked)
            },
            cancel: { [weak self] in self?.engine?.cancelSend(batchId: $0) },
            retry: { [weak self] in self?.engine?.retrySend(batchId: $0) },
            dismiss: { [weak self] in self?.engine?.dismissSend(batchId: $0) },
            clearFinished: { [weak self] in self?.engine?.clearFinishedSends() },
            dismissError: { [weak self] in self?.engine?.dismissSendError() })
    }

    /// Reads what was picked off the main thread, then shows it on the Send files screen.
    private func stage(_ read: @escaping (PickedURLs) -> [StagedFile]) {
        let picked = self.picked
        DispatchQueue.global(qos: .userInitiated).async {
            let staged = read(picked)
            DispatchQueue.main.async { [weak self] in
                self?.sendPicks.add(staged)
                self?.sendPicks.open = true
            }
        }
    }

    /// Files going or coming keep the app running for a while in the background.
    func keepSending(_ view: AppView) {
        if view.send.active > 0 || view.receive.active > 0 {
            guard sendTask == .invalid else { return }
            sendTask = UIApplication.shared.beginBackgroundTask(withName: "Sending files") { [weak self] in
                self?.endSendTask()
            }
        } else {
            endSendTask()
        }
    }

    private func endSendTask() {
        guard sendTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(sendTask)
        sendTask = .invalid
    }

    private let frames = RemoteFrames()

    /// The app's own folder for videos.
    private static func videosFolder() -> String {
        let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Videos", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.path
    }

    /// A recovery phrase on the pasteboard (E108): this device only, never Handoff, gone after a minute.
    private static func copySensitive(_ text: String) {
        UIPasteboard.general.setItems(
            [[UTType.plainText.identifier: text]],
            options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(60)])
    }

    /// Offers the phrase as a text file through the share sheet, which includes Save to Files. The
    /// file is written with complete protection and removed once the sheet closes.
    private static func savePhrase(fileName: String, text: String) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(fileName)
        guard (try? Data(text.utf8).write(to: url, options: [.atomic, .completeFileProtection])) != nil else { return }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.excludedActivityTypes = [.postToFacebook, .postToTwitter, .postToWeibo, .assignToContact, .addToReadingList]
        sheet.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: url) }
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        scene?.keyWindow?.rootViewController?.present(sheet, animated: true)
    }

    private static func share(_ path: String) {
        let sheet = UIActivityViewController(activityItems: [URL(fileURLWithPath: path)], applicationActivities: nil)
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        scene?.keyWindow?.rootViewController?.present(sheet, animated: true)
    }

    private var studioIntents: StudioIntents {
        StudioIntents(
            openComposer: { [weak self] in self?.engine?.studioOpenComposer() },
            closeComposer: { [weak self] in self?.engine?.studioCloseComposer() },
            create: { [weak self] brief, aspect, language, seconds, style in
                self?.engine?.studioCreate(
                    brief: brief, aspect: aspect, language: language, seconds: seconds, styleId: style)
            },
            openVideo: { [weak self] in self?.engine?.studioOpenVideo(id: $0) },
            closeVideo: { [weak self] in self?.engine?.studioCloseVideo() },
            ask: { [weak self] in self?.engine?.studioAsk(instruction: $0) },
            applyProposal: { [weak self] in self?.engine?.studioApplyProposal() },
            discardProposal: { [weak self] in self?.engine?.studioDiscardProposal() },
            undo: { [weak self] in self?.engine?.studioUndo() },
            animate: { [weak self] in self?.engine?.studioAnimate(sceneId: $0) },
            animateAll: { [weak self] in self?.engine?.studioAnimateAll() },
            cancelRun: { [weak self] in self?.engine?.studioCancelRun() },
            openRender: { [weak self] in self?.engine?.studioOpenRender() },
            closeRender: { [weak self] in self?.engine?.studioCloseRender() },
            render: { [weak self] in self?.engine?.studioRender(quality: $0) },
            cancelRender: { [weak self] in self?.engine?.studioCancelRender(jobId: $0) },
            thumbnail: { [weak self] in self?.engine?.studioThumbnail(hash: $0) },
            openVoice: { [weak self] in self?.engine?.studioOpenVoice() },
            closeVoice: { [weak self] in self?.engine?.studioCloseVoice() },
            pickEngine: { [weak self] in self?.engine?.studioVoicePickEngine(engine: $0) },
            pickVoice: { [weak self] in self?.engine?.studioVoicePick(reference: $0) },
            speak: { [weak self] in self?.engine?.studioSpeak() },
            cancelSpeak: { [weak self] in self?.engine?.studioCancelSpeak() },
            caption: { [weak self] in self?.engine?.studioCaptionScene(sceneId: $0) },
            openTimeline: { [weak self] in self?.engine?.studioOpenTimeline() },
            closeTimeline: { [weak self] in self?.engine?.studioCloseTimeline() },
            nudge: { [weak self] clip, seconds in self?.engine?.studioClipNudge(clipId: clip, seconds: seconds) },
            trim: { [weak self] clip, end, seconds in
                self?.engine?.studioClipTrim(clipId: clip, end: end, seconds: seconds)
            },
            gain: { [weak self] clip, value in self?.engine?.studioClipGain(clipId: clip, gain: value) },
            fades: { [weak self] clip, seconds in self?.engine?.studioClipFades(clipId: clip, seconds: seconds) },
            removeClip: { [weak self] in self?.engine?.studioClipRemove(clipId: $0) },
            addMusic: { [weak self] in self?.engine?.studioAddMusic(hash: $0) },
            muteTrack: { [weak self] track, muted in self?.engine?.studioTrackMute(trackId: track, muted: muted) },
            download: { [weak self] in self?.engine?.studioDownload(jobId: $0, folder: Self.videosFolder()) },
            downloadStop: { [weak self] in self?.engine?.studioDownloadStop() },
            downloadDismiss: { [weak self] in self?.engine?.studioDownloadDismiss() },
            shareVideo: { Self.share($0) })
    }

    private var remoteIntents: RemoteIntents {
        RemoteIntents(
            frames: frames,
            open: { [weak self] id in
                guard let self else { return }
                self.engine?.remoteOpen(systemId: id, sink: self.frames)
            },
            close: { [weak self] in self?.engine?.remoteClose() },
            submitPassword: { [weak self] in self?.engine?.remoteSubmitPassword(password: $0) },
            usePassword: { [weak self] in self?.engine?.remoteUsePassword() },
            pointer: { [weak self] in self?.engine?.remotePointer(pointer: $0) },
            text: { [weak self] in self?.engine?.remoteText(text: $0) },
            key: { [weak self] in self?.engine?.remoteKey(key: $0) },
            sendClipboard: { [weak self] in
                self?.engine?.remoteSendClipboard(text: UIPasteboard.general.string ?? "")
            },
            copyClipboard: { [weak self] in
                UIPasteboard.general.string = $0
                self?.engine?.remoteClipboardTaken()
            },
            clipboardTaken: { [weak self] in self?.engine?.remoteClipboardTaken() },
            dismissNote: { [weak self] in self?.engine?.remoteDismissNote() })
    }

    private var engine: Engine? { core?.engine() }

    func askForNotifications() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { allowed, _ in
            guard allowed else { return }
            Task { @MainActor in UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func registerPushToken(_ token: String) {
        engine?.registerPushToken(token: token)
    }

    /// A tapped push, with what the server put next to its alert.
    func openPush(category: String, notificationId: Int64?, itemId: String? = nil) {
        // An attack's push names its server and site, and opens that site's attacks (E111).
        engine?.notificationTapped(id: notificationId, category: category, itemId: itemId)
        tab = tabFor(notificationDestination(category: category), connected: view?.connection != nil)
    }
    private var lastBiometric: UInt64 = 0
    private var lastUnlockPrompt: UInt64 = 0

    /// Tells the core what the phone can check. A face or finger added while away changes the
    /// domain state, so the app lock stops trusting biometrics until the passcode is entered.
    private func reportBiometrics() {
        let context = LAContext()
        var problem: NSError?
        let ready = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &problem)
        let enrollment = context.evaluatedPolicyDomainState?.base64EncodedString()
        switch (ready, context.biometryType) {
        case (true, .faceID): engine?.setBiometricCapability(kind: .face, name: "Face ID", enrollment: enrollment)
        case (true, .touchID):
            engine?.setBiometricCapability(kind: .fingerprint, name: "Touch ID", enrollment: enrollment)
        case (true, _): engine?.setBiometricCapability(kind: .face, name: "Optic ID", enrollment: enrollment)
        default: engine?.setBiometricCapability(kind: .none, name: "", enrollment: nil)
        }
    }

    /// The app lock's own check: biometrics only, so the phone's passcode can't stand in for the app's.
    func unlockIfAsked(_ view: AppView) {
        guard let request = view.lock.biometric, request.id != lastUnlockPrompt else { return }
        lastUnlockPrompt = request.id
        let id = request.id
        let context = LAContext()
        context.localizedFallbackTitle = ""
        context.localizedCancelTitle = view.lock.entry.length > 0 ? "Use passcode" : "Use password"
        var problem: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &problem) else {
            engine?.biometricResult(id: id, confirmed: false)
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: request.reason) {
            [weak self] ok, _ in
            Task { @MainActor in self?.engine?.biometricResult(id: id, confirmed: ok) }
        }
    }

    /// Runs the phone's own check. The core only asks for the value if this says yes.
    func confirmIdentityIfAsked(_ view: AppView) {
        // The same check guards a Cloudflare token pasted on the phone.
        guard let request = view.vault.biometric ?? view.cloudflare.biometric ?? view.recoveryPhrases.biometric,
            request.id != lastBiometric
        else { return }
        lastBiometric = request.id
        let id = request.id
        let context = LAContext()
        var problem: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &problem) else {
            engine?.biometricResult(id: id, confirmed: false)
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: request.reason) { [weak self] ok, _ in
            Task { @MainActor in self?.engine?.biometricResult(id: id, confirmed: ok) }
        }
    }

    private var cloudflareIntents: CloudflareIntents {
        CloudflareIntents(
            openZone: { [weak self] in self?.engine?.cloudflareOpenZone(id: $0) },
            closeZone: { [weak self] in self?.engine?.cloudflareCloseZone() },
            setDevMode: { [weak self] in self?.engine?.cloudflareSetDevMode(on: $0) },
            setUnderAttack: { [weak self] in self?.engine?.cloudflareSetUnderAttack(on: $0) },
            setAiBotsBlocked: { [weak self] in self?.engine?.cloudflareSetAiBotsBlocked(on: $0) },
            newRecord: { [weak self] in self?.engine?.cloudflareNewRecord() },
            editRecord: { [weak self] in self?.engine?.cloudflareEditRecord(id: $0) },
            closeRecordForm: { [weak self] in self?.engine?.cloudflareCloseRecordForm() },
            saveRecord: { [weak self] in self?.engine?.cloudflareSaveRecord(draft: $0) },
            setProxied: { [weak self] in self?.engine?.cloudflareSetProxied(id: $0, proxied: $1) },
            deleteRecord: { [weak self] in self?.engine?.cloudflareDeleteRecord(id: $0) },
            openTokenForm: { [weak self] in self?.engine?.cloudflareOpenTokenForm(accountId: $0) },
            closeTokenForm: { [weak self] in self?.engine?.cloudflareCloseTokenForm() },
            saveToken: { [weak self] in self?.engine?.cloudflareSaveToken(token: $0, label: $1) },
            checkToken: { [weak self] in self?.engine?.cloudflareCheckToken(accountId: $0) },
            removeToken: { [weak self] in self?.engine?.cloudflareRemoveToken(accountId: $0) },
            openAddDomain: { [weak self] in self?.engine?.cloudflareOpenAddDomain(accountId: $0) },
            closeAddDomain: { [weak self] in self?.engine?.cloudflareCloseAddDomain() },
            addDomain: { [weak self] in self?.engine?.cloudflareAddDomain(name: $0, cloudflareAccountId: $1) },
            checkActivation: { [weak self] in self?.engine?.cloudflareCheckActivation() },
            openPointDomain: { [weak self] in self?.engine?.cloudflareOpenPointDomain() },
            closePointDomain: { [weak self] in self?.engine?.cloudflareClosePointDomain() },
            previewPointDomain: { [weak self] name, server, www, proxied in
                self?.engine?.cloudflarePreviewPointDomain(
                    name: name, serverId: server, includeWww: www, proxied: proxied)
            },
            applyPointDomain: { [weak self] in self?.engine?.cloudflareApplyPointDomain() },
            openTab: { [weak self] in self?.engine?.cloudflareOpenTab(tab: $0) },
            changeSetting: { [weak self] in self?.engine?.cloudflareChangeSetting(key: $0, value: $1) },
            setRuleEnabled: { [weak self] in self?.engine?.cloudflareSetRuleEnabled(id: $0, enabled: $1) },
            deleteRule: { [weak self] in self?.engine?.cloudflareDeleteRule(id: $0) },
            openRuleBuilder: { [weak self] in self?.engine?.cloudflareOpenRuleBuilder() },
            closeRuleBuilder: { [weak self] in self?.engine?.cloudflareCloseRuleBuilder() },
            addRule: { [weak self] kind, values, path, prefix, description in
                self?.engine?.cloudflareAddRule(
                    kind: kind, values: values, path: path, prefix: prefix, description: description)
            },
            openAccessRuleForm: { [weak self] in self?.engine?.cloudflareOpenAccessRuleForm() },
            closeAccessRuleForm: { [weak self] in self?.engine?.cloudflareCloseAccessRuleForm() },
            addAccessRule: { [weak self] in self?.engine?.cloudflareAddAccessRule(value: $0, mode: $1, notes: $2) },
            deleteAccessRule: { [weak self] in self?.engine?.cloudflareDeleteAccessRule(id: $0) },
            purgeEverything: { [weak self] in self?.engine?.cloudflarePurgeEverything() },
            purgeUrls: { [weak self] in self?.engine?.cloudflarePurgeUrls(text: $0) },
            gatePrepare: { [weak self] in self?.engine?.cloudflareGatePrepare(teamName: $0) },
            gateSwitch: { [weak self] in self?.engine?.cloudflareGateSwitch(hostname: $0, on: $1) },
            gateEdit: { [weak self] in self?.engine?.cloudflareGateEdit(hostname: $0) },
            gateClose: { [weak self] in self?.engine?.cloudflareGateClose() },
            gateAddPeople: { [weak self] in self?.engine?.cloudflareGateAddPeople(text: $0) },
            gateRemovePerson: { [weak self] in self?.engine?.cloudflareGateRemovePerson(value: $0, domain: $1) },
            gateSetSession: { [weak self] in self?.engine?.cloudflareGateSetSession(session: $0) },
            gateSave: { [weak self] in self?.engine?.cloudflareGateSave() },
            gateTurnOff: { [weak self] in self?.engine?.cloudflareGateTurnOff(hostname: $0) },
            gateProxy: { [weak self] in self?.engine?.cloudflareGateProxy(hostname: $0) },
            gateLetThrough: { [weak self] in self?.engine?.cloudflareGateLetThrough(hostname: $0) },
            openIpLimit: { [weak self] in self?.engine?.cloudflareOpenIpLimit(ruleId: $0) },
            closeIpLimit: { [weak self] in self?.engine?.cloudflareCloseIpLimit() },
            ipLimitSetName: { [weak self] in self?.engine?.cloudflareIpLimitSetName(hostname: $0) },
            ipLimitSetScope: { [weak self] in self?.engine?.cloudflareIpLimitSetScope(wholeSite: $0) },
            ipLimitSetPath: { [weak self] in self?.engine?.cloudflareIpLimitSetPath(path: $0) },
            ipLimitSetPrefix: { [weak self] in self?.engine?.cloudflareIpLimitSetPrefix(prefix: $0) },
            ipLimitAddAddresses: { [weak self] in self?.engine?.cloudflareIpLimitAddAddresses(text: $0) },
            ipLimitRemoveAddress: { [weak self] in self?.engine?.cloudflareIpLimitRemoveAddress(address: $0) },
            ipLimitAddThisComputer: { [weak self] in self?.engine?.cloudflareIpLimitAddThisComputer() },
            ipLimitSave: { [weak self] in self?.engine?.cloudflareIpLimitSave() },
            ipLimitSetEnabled: { [weak self] in self?.engine?.cloudflareIpLimitSetEnabled(id: $0, enabled: $1) },
            ipLimitDelete: { [weak self] in self?.engine?.cloudflareIpLimitDelete(id: $0) },
            newWidget: { [weak self] in self?.engine?.cloudflareNewWidget() },
            editWidget: { [weak self] in self?.engine?.cloudflareEditWidget(sitekey: $0) },
            closeWidgetForm: { [weak self] in self?.engine?.cloudflareCloseWidgetForm() },
            saveWidget: { [weak self] in self?.engine?.cloudflareSaveWidget(draft: $0) },
            deleteWidget: { [weak self] in self?.engine?.cloudflareDeleteWidget(sitekey: $0) },
            revealSecret: { [weak self] in self?.engine?.cloudflareRevealSecret(sitekey: $0) },
            hideSecret: { [weak self] in self?.engine?.cloudflareHideSecret() },
            rotateSecret: { [weak self] in self?.engine?.cloudflareRotateSecret(sitekey: $0, now: $1) },
            dnsTokenMint: { [weak self] in self?.engine?.cloudflareDnsTokenMint(serverId: $0) },
            dnsTokenPaste: { [weak self] in self?.engine?.cloudflareDnsTokenPaste(serverId: $0, token: $1) },
            dnsTokenRemove: { [weak self] in self?.engine?.cloudflareDnsTokenRemove(serverId: $0) },
            openOrigin: { [weak self] in self?.engine?.cloudflareOpenOrigin(serverId: $0) },
            closeOrigin: { [weak self] in self?.engine?.cloudflareCloseOrigin() },
            originMode: { [weak self] in self?.engine?.cloudflareOriginMode(mode: $0) },
            closeOriginDialog: { [weak self] in self?.engine?.cloudflareCloseOriginDialog() },
            originApply: { [weak self] in self?.engine?.cloudflareOriginApply() },
            lockOpen: { [weak self] in self?.engine?.cloudflareLockOpen(enable: $0) },
            lockSetAop: { [weak self] in self?.engine?.cloudflareLockSetAop(on: $0) },
            tunnelSetupOpen: { [weak self] in self?.engine?.cloudflareTunnelSetupOpen() },
            tunnelSetupAccount: { [weak self] in self?.engine?.cloudflareTunnelSetupAccount(accountId: $0) },
            tunnelSetupSsh: { [weak self] in self?.engine?.cloudflareTunnelSetupSsh(route: $0, name: $1) },
            tunnelSetupAck: { [weak self] in self?.engine?.cloudflareTunnelSetupAck(acked: $0) },
            tunnelPortsOpen: { [weak self] in self?.engine?.cloudflareTunnelPortsOpen() },
            tunnelSshOpen: { [weak self] in self?.engine?.cloudflareTunnelSshOpen() },
            tunnelSshMode: { [weak self] in self?.engine?.cloudflareTunnelSshMode(mode: $0) },
            tunnelSshTest: { [weak self] in self?.engine?.cloudflareTunnelSshTest() },
            tunnelJoinMesh: { [weak self] in self?.engine?.cloudflareTunnelJoinMesh() },
            tunnelSshApply: { [weak self] in self?.engine?.cloudflareTunnelSshApply(phrase: $0, password: $1) },
            tunnelOffOpen: { [weak self] in self?.engine?.cloudflareTunnelOffOpen() },
            tunnelOffReopen: { [weak self] in self?.engine?.cloudflareTunnelOffReopen(reopenWeb: $0) },
            tunnelOffPointBack: { [weak self] in self?.engine?.cloudflareTunnelOffPointBack(pointBack: $0) },
            tunnelBreakGlass: { [weak self] in self?.engine?.cloudflareTunnelBreakGlass(enabled: $0, delayMinutes: $1) },
            firewallKeep: { [weak self] in self?.engine?.cloudflareFirewallKeep() },
            firewallRevert: { [weak self] in self?.engine?.cloudflareFirewallRevert() })
    }

    private var gitIntents: GitIntents {
        GitIntents(
            openDiff: { [weak self] in self?.engine?.openGitDiff(path: $0, group: $1) },
            closeDiff: { [weak self] in self?.engine?.closeGitDiff() },
            openBranches: { [weak self] in self?.engine?.openGitBranches() },
            closeBranches: { [weak self] in self?.engine?.closeGitBranches() },
            openTags: { [weak self] in self?.engine?.gitOpenTags() },
            closeTags: { [weak self] in self?.engine?.gitCloseTags() },
            suggestTag: { [weak self] in self?.engine?.gitSuggestTag() },
            createTag: { [weak self] tag, message, push in
                self?.engine?.gitCreateTag(tag: tag, message: message, push: push)
            },
            suggestCommit: { [weak self] in self?.engine?.gitSuggestCommitMessage() },
            suggestBranch: { [weak self] in self?.engine?.gitSuggestBranchName() },
            aiTaken: { [weak self] in self?.engine?.gitAiTaken() },
            cancelAi: { [weak self] in self?.engine?.gitCancelAi() },
            resolveWithAi: { [weak self] in self?.engine?.gitResolveWithAi(path: $0) },
            deleteTag: { [weak self] in self?.engine?.gitDeleteTag(tag: $0) },
            openPr: { [weak self] in self?.engine?.gitOpenPr() },
            closePr: { [weak self] in self?.engine?.gitClosePr() },
            suggestPr: { [weak self] in self?.engine?.gitSuggestPr() },
            prSuggestionTaken: { [weak self] in self?.engine?.gitPrSuggestionTaken() },
            createPr: { [weak self] title, body, draft in
                self?.engine?.gitCreatePr(title: title, body: body, draft: draft)
            },
            reviewPr: { [weak self] in self?.engine?.gitReviewPr() },
            prReviewTaken: { [weak self] in self?.engine?.gitPrReviewTaken() },
            postReview: { [weak self] in self?.engine?.gitPostReview(body: $0) },
            cancelPrAi: { [weak self] in self?.engine?.gitCancelPrAi() },
            applyVersion: { [weak self] in self?.engine?.gitApplyVersion(tag: $0) },
            cancelVersion: { [weak self] in self?.engine?.gitCancelVersion() },
            versionToggle: { [weak self] in self?.engine?.gitVersionToggle(path: $0) },
            closeVersion: { [weak self] in self?.engine?.gitCloseVersion() },
            stage: { [weak self] in self?.engine?.gitStage(paths: $0) },
            unstage: { [weak self] in self?.engine?.gitUnstage(paths: $0) },
            discard: { [weak self] in self?.engine?.gitDiscard(path: $0, group: $1) },
            commit: { [weak self] in self?.engine?.gitCommit(message: $0, push: $1) },
            fetch: { [weak self] in self?.engine?.gitFetch() },
            pull: { [weak self] in self?.engine?.gitPull() },
            push: { [weak self] in self?.engine?.gitPush() },
            checkout: { [weak self] in self?.engine?.gitCheckout(name: $0) },
            createBranch: { [weak self] in self?.engine?.gitCreateBranch(name: $0) },
            deleteBranch: { [weak self] in self?.engine?.gitDeleteBranch(name: $0) },
            stashPush: { [weak self] in self?.engine?.gitStashPush(message: $0) },
            stashPop: { [weak self] in self?.engine?.gitStashPop(reference: $0) },
            stashDrop: { [weak self] in self?.engine?.gitStashDrop(reference: $0) },
            resolve: { [weak self] in self?.engine?.gitResolve(path: $0, pick: $1) },
            abort: { [weak self] in self?.engine?.gitAbort() })
    }

    func scene(_ phase: ScenePhase) {
        switch phase {
        case .active:
            reportBiometrics()
            core?.lifecycle(change: .foregrounded)
        case .background: core?.lifecycle(change: .backgrounded(graceMs: backgroundGraceMs))
        default: break
        }
    }

    /// The platform's passkey prompt for a sign-in the core started (E115).
    private lazy var passkeyPrompt = PasskeyPrompt(
        provider: AuthenticationServicesPasskeys(),
        finish: { [weak self] id, answer in self?.engine?.finishPasskeySignIn(challengeId: id, credentialJson: answer) },
        cancel: { [weak self] noPasskey in self?.engine?.cancelPasskeySignIn(noPasskey: noPasskey) })

    /// Sign in with Apple for a sign-in the core started (E117).
    private lazy var applePrompt = AppleSignInPrompt(
        provider: AuthenticationServicesAppleSignIn(),
        finish: { [weak self] nonce, token, code, name in
            self?.engine?.finishProviderSignIn(nonce: nonce, idToken: token, authorizationCode: code, name: name)
        },
        cancel: { [weak self] in self?.engine?.cancelProviderSignIn() })

    /// The browser sign-in, going straight to `provider` when one is given (E117).
    private func signIn(provider: String? = nil) {
        guard let core else { return }
        let device = UIDevice.current.model
        let link =
            provider.map { core.beginSignInWithProvider(deviceName: device, provider: $0) }
            ?? core.beginSignIn(deviceName: device)
        guard let url = URL(string: link.url) else { return }
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "com.runovahq.app") {
            [weak self] callback, _ in
            guard let callback else { return }
            Task { @MainActor in self?.core?.finishSignIn(url: callback.absoluteString) }
        }
        session.presentationContextProvider = self
        browser = session
        session.start()
    }
}

extension AppModel: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first ?? ASPresentationAnchor()
    }
}

/// Called on the core's own threads.
private final class Listener: ViewListener {
    // A let, since it is set once: a mutable stored property breaks the Sendable conformance
    // ViewListener asks for (a warning now, an error in the Swift 6 language mode).
    weak let model: AppModel?

    init(model: AppModel) { self.model = model }

    func onView(view: AppView) {
        Task { @MainActor [weak model] in
            model?.view = view
            model?.confirmIdentityIfAsked(view)
            model?.unlockIfAsked(view)
            model?.keepSending(view)
        }
    }
}
