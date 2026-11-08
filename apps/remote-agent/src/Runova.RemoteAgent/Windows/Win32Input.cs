using System.Text.Json.Nodes;

namespace Runova.RemoteAgent.Windows;

/// <summary>One Win32 input step for a controller event.</summary>
public abstract record InputStep
{
    public sealed record Move(int X, int Y) : InputStep;

    public sealed record Mouse(uint Flags, int Data) : InputStep;

    public sealed record Key(ushort VirtualKey, bool Down, bool Extended) : InputStep;

    public sealed record Unicode(char Character) : InputStep;
}

/// <summary>
/// The app's `RemoteInputEvent` as Win32 input steps, the same mapping as the desktop's PowerShell
/// helper (apps/desktop/src/main/remote/input/backends.ts): pointer coordinates normalized to the
/// primary screen, one wheel notch per unit, special keys by virtual-key code, text as Unicode.
/// </summary>
public static class Win32Input
{
    private const uint LeftDown = 0x0002;
    private const uint LeftUp = 0x0004;
    private const uint RightDown = 0x0008;
    private const uint RightUp = 0x0010;
    private const uint MiddleDown = 0x0020;
    private const uint MiddleUp = 0x0040;
    private const uint Wheel = 0x0800;

    private static readonly Dictionary<string, ushort> _virtualKeys = new(StringComparer.Ordinal)
    {
        ["Enter"] = 0x0d,
        ["NumpadEnter"] = 0x0d,
        ["Tab"] = 0x09,
        ["Backspace"] = 0x08,
        ["Delete"] = 0x2e,
        ["Escape"] = 0x1b,
        ["ArrowLeft"] = 0x25,
        ["ArrowUp"] = 0x26,
        ["ArrowRight"] = 0x27,
        ["ArrowDown"] = 0x28,
        ["Home"] = 0x24,
        ["End"] = 0x23,
        ["PageUp"] = 0x21,
        ["PageDown"] = 0x22,
        ["Insert"] = 0x2d,
        ["ShiftLeft"] = 0xa0,
        ["ShiftRight"] = 0xa1,
        ["ControlLeft"] = 0xa2,
        ["ControlRight"] = 0xa3,
        ["AltLeft"] = 0xa4,
        ["AltRight"] = 0xa5,
        ["MetaLeft"] = 0x5b,
        ["MetaRight"] = 0x5c,
        ["CapsLock"] = 0x14,
        ["F1"] = 0x70,
        ["F2"] = 0x71,
        ["F3"] = 0x72,
        ["F4"] = 0x73,
        ["F5"] = 0x74,
        ["F6"] = 0x75,
        ["F7"] = 0x76,
        ["F8"] = 0x77,
        ["F9"] = 0x78,
        ["F10"] = 0x79,
        ["F11"] = 0x7a,
        ["F12"] = 0x7b,
    };

    private static readonly HashSet<string> _extended = new(StringComparer.Ordinal)
    {
        "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End", "PageUp", "PageDown",
        "Insert", "Delete", "NumpadEnter", "ControlRight", "AltRight",
    };

    public static IReadOnlyList<InputStep> Steps(JsonObject inputEvent, int screenWidth, int screenHeight)
    {
        ArgumentNullException.ThrowIfNull(inputEvent);
        int Px(string axis, int size) => Math.Clamp((int)Math.Round(((double?)inputEvent[axis] ?? 0) * size), 0, size - 1);
        switch ((string?)inputEvent["k"])
        {
            case "move":
                return [new InputStep.Move(Px("x", screenWidth), Px("y", screenHeight))];
            case "down" or "up":
                {
                    var down = (string?)inputEvent["k"] == "down";
                    uint flag = (string?)inputEvent["button"] switch
                    {
                        "right" => down ? RightDown : RightUp,
                        "middle" => down ? MiddleDown : MiddleUp,
                        _ => down ? LeftDown : LeftUp,
                    };
                    return [new InputStep.Move(Px("x", screenWidth), Px("y", screenHeight)), new InputStep.Mouse(flag, 0)];
                }
            case "wheel":
                return [new InputStep.Mouse(Wheel, -(int)Math.Round((double?)inputEvent["dy"] ?? 0) * 120)];
            case "key":
                {
                    var code = (string?)inputEvent["code"] ?? "";
                    return _virtualKeys.TryGetValue(code, out var vk)
                        ? [new InputStep.Key(vk, (bool?)inputEvent["down"] ?? false, _extended.Contains(code))]
                        : [];
                }
            case "text":
                return [.. ((string?)inputEvent["text"] ?? "").Select(c => new InputStep.Unicode(c))];
            default:
                return [];
        }
    }
}
