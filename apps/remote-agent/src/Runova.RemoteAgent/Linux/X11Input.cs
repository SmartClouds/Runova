using System.Text;
using System.Text.Json.Nodes;

namespace Runova.RemoteAgent.Linux;

/// <summary>One XTest step for a controller event.</summary>
public abstract record X11Step
{
    public sealed record Move(int X, int Y) : X11Step;

    public sealed record Button(int Number, bool Down) : X11Step;

    public sealed record Key(int Keysym, bool Down) : X11Step;

    public sealed record Text(int CodePoint) : X11Step;
}

/// <summary>
/// The app's `RemoteInputEvent` as XTest steps (E65), the same mapping as the desktop's X11 helper
/// (apps/desktop/src/main/remote/input/backends.ts).
/// </summary>
public static class X11Input
{
    private static readonly Dictionary<string, int> _keysyms = new(StringComparer.Ordinal)
    {
        ["Enter"] = 0xff0d,
        ["NumpadEnter"] = 0xff8d,
        ["Tab"] = 0xff09,
        ["Backspace"] = 0xff08,
        ["Delete"] = 0xffff,
        ["Escape"] = 0xff1b,
        ["ArrowLeft"] = 0xff51,
        ["ArrowUp"] = 0xff52,
        ["ArrowRight"] = 0xff53,
        ["ArrowDown"] = 0xff54,
        ["Home"] = 0xff50,
        ["End"] = 0xff57,
        ["PageUp"] = 0xff55,
        ["PageDown"] = 0xff56,
        ["Insert"] = 0xff63,
        ["ShiftLeft"] = 0xffe1,
        ["ShiftRight"] = 0xffe2,
        ["ControlLeft"] = 0xffe3,
        ["ControlRight"] = 0xffe4,
        ["AltLeft"] = 0xffe9,
        ["AltRight"] = 0xffea,
        ["MetaLeft"] = 0xffeb,
        ["MetaRight"] = 0xffec,
        ["CapsLock"] = 0xffe5,
        ["F1"] = 0xffbe,
        ["F2"] = 0xffbf,
        ["F3"] = 0xffc0,
        ["F4"] = 0xffc1,
        ["F5"] = 0xffc2,
        ["F6"] = 0xffc3,
        ["F7"] = 0xffc4,
        ["F8"] = 0xffc5,
        ["F9"] = 0xffc6,
        ["F10"] = 0xffc7,
        ["F11"] = 0xffc8,
        ["F12"] = 0xffc9,
    };

    public static IReadOnlyList<X11Step> Steps(JsonObject inputEvent, int screenWidth, int screenHeight)
    {
        ArgumentNullException.ThrowIfNull(inputEvent);
        int Px(string axis, int size) => Math.Clamp((int)Math.Round(((double?)inputEvent[axis] ?? 0) * size), 0, size - 1);
        switch ((string?)inputEvent["k"])
        {
            case "move":
                return [new X11Step.Move(Px("x", screenWidth), Px("y", screenHeight))];
            case "down" or "up":
                {
                    var number = (string?)inputEvent["button"] switch
                    {
                        "right" => 3,
                        "middle" => 2,
                        _ => 1,
                    };
                    return [new X11Step.Move(Px("x", screenWidth), Px("y", screenHeight)), new X11Step.Button(number, (string?)inputEvent["k"] == "down")];
                }
            case "wheel":
                return [.. Notches((double?)inputEvent["dy"] ?? 0, 4, 5), .. Notches((double?)inputEvent["dx"] ?? 0, 6, 7)];
            case "key":
                return _keysyms.TryGetValue((string?)inputEvent["code"] ?? "", out var keysym)
                    ? [new X11Step.Key(keysym, (bool?)inputEvent["down"] ?? false)]
                    : [];
            case "text":
                return [.. ((string?)inputEvent["text"] ?? "").EnumerateRunes().Select((Rune rune) => new X11Step.Text(rune.Value))];
            default:
                return [];
        }
    }

    /// <summary>X has no wheel: a notch is a click of one button per direction.</summary>
    private static IEnumerable<X11Step> Notches(double amount, int negative, int positive)
    {
        var button = amount < 0 ? negative : positive;
        for (var i = 0; i < Math.Abs((int)Math.Round(amount)); i++)
        {
            yield return new X11Step.Button(button, true);
            yield return new X11Step.Button(button, false);
        }
    }
}
