using System.Runtime.Versioning;

namespace Runova.RemoteAgent.Mac;

/// <summary>
/// Registers the agent as a LaunchAgent that macOS starts at the login window, as root (E65). Only a
/// process in that session can see and drive the login window, so a LaunchDaemon can not do this.
/// </summary>
public static class MacInstaller
{
    private const string Label = "com.runova.anywhere.agent";
    private const string Folder = "/Library/Application Support/Runova/Agent";
    private const string PlistFile = $"/Library/LaunchAgents/{Label}.plist";

    public static string Plist =>
        $"""
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>{Label}</string>
          <key>LimitLoadToSessionType</key>
          <string>LoginWindow</string>
          <key>ProgramArguments</key>
          <array>
            <string>{Folder}/RunovaAgent</string>
            <string>run</string>
          </array>
          <key>EnvironmentVariables</key>
          <dict>
            <key>DOTNET_BUNDLE_EXTRACT_BASE_DIR</key>
            <string>{Folder}/extract</string>
          </dict>
          <key>RunAtLoad</key>
          <true/>
          <key>KeepAlive</key>
          <true/>
        </dict>
        </plist>

        """.ReplaceLineEndings("\n");

    [SupportedOSPlatform("macos")]
    public static int Install()
    {
        // The config store made this folder for root alone; the program goes in beside it.
        ProcessRunner.Run("launchctl", $"bootout loginwindow/{Label}", allowFailure: true);
        File.Copy(Environment.ProcessPath!, Path.Combine(Folder, "RunovaAgent"), overwrite: true);
        File.SetUnixFileMode(Path.Combine(Folder, "RunovaAgent"), UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        File.WriteAllText(PlistFile, Plist);
        File.SetUnixFileMode(PlistFile, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead);

        // Fails unless the login window is showing now; launchd loads it the next time it does.
        ProcessRunner.Run("launchctl", $"bootstrap loginwindow \"{PlistFile}\"", allowFailure: true);
        return 0;
    }

    [SupportedOSPlatform("macos")]
    public static int Uninstall()
    {
        ProcessRunner.Run("launchctl", $"bootout loginwindow/{Label}", allowFailure: true);
        File.Delete(PlistFile);
        if (Directory.Exists(Folder))
        {
            Directory.Delete(Folder, recursive: true);
        }

        return 0;
    }
}
