using System.Buffers.Binary;

namespace Runova.RemoteAgent.Core;

public sealed record LinkMessage(byte Kind, byte[] Payload);

/// <summary>
/// Runova Anywhere link frames, as packages/protocol/src/link.ts writes them: `0x01` text, `0x02`
/// binary, `0x03` fragment `[id u32][index u16][count u16][inner kind][chunk]`, at most 60 KiB each.
/// </summary>
public static class LinkFraming
{
    public const byte Text = 0x01;
    public const byte Binary = 0x02;
    public const byte Fragment = 0x03;
    public const int MaxFrame = 60 * 1024;
    public const int MaxMessage = 32 * 1024 * 1024;
    private const int FragmentHeader = 10;
    private const int FragmentChunk = MaxFrame - FragmentHeader;

    public static IReadOnlyList<byte[]> Encode(byte kind, ReadOnlySpan<byte> payload, uint messageId)
    {
        if (kind is not (Text or Binary))
        {
            throw new ArgumentOutOfRangeException(nameof(kind), "Only text and binary messages are framed.");
        }

        if (payload.Length + 1 <= MaxFrame)
        {
            var frame = new byte[payload.Length + 1];
            frame[0] = kind;
            payload.CopyTo(frame.AsSpan(1));
            return [frame];
        }

        var count = (payload.Length + FragmentChunk - 1) / FragmentChunk;
        var frames = new List<byte[]>(count);
        for (var index = 0; index < count; index++)
        {
            var chunk = payload.Slice(index * FragmentChunk, Math.Min(FragmentChunk, payload.Length - (index * FragmentChunk)));
            var frame = new byte[FragmentHeader + chunk.Length];
            frame[0] = Fragment;
            BinaryPrimitives.WriteUInt32BigEndian(frame.AsSpan(1), messageId);
            BinaryPrimitives.WriteUInt16BigEndian(frame.AsSpan(5), (ushort)index);
            BinaryPrimitives.WriteUInt16BigEndian(frame.AsSpan(7), (ushort)count);
            frame[9] = kind;
            chunk.CopyTo(frame.AsSpan(FragmentHeader));
            frames.Add(frame);
        }

        return frames;
    }
}

/// <summary>Turns frames back into messages; throws on anything malformed, and the link closes.</summary>
public sealed class LinkReassembler
{
    private (uint Id, int Count, int Next, byte Kind, MemoryStream Data)? _partial;

    public LinkMessage? Push(byte[] frame)
    {
        ArgumentNullException.ThrowIfNull(frame);
        if (frame.Length == 0)
        {
            throw new InvalidDataException("An empty frame.");
        }

        var kind = frame[0];
        if (kind is LinkFraming.Text or LinkFraming.Binary)
        {
            return _partial is not null ? throw new InvalidDataException("A whole message inside a fragmented one.") : new LinkMessage(kind, frame[1..]);
        }

        if (kind != LinkFraming.Fragment || frame.Length < 10)
        {
            throw new InvalidDataException("An unknown or short frame.");
        }

        var id = BinaryPrimitives.ReadUInt32BigEndian(frame.AsSpan(1));
        var index = BinaryPrimitives.ReadUInt16BigEndian(frame.AsSpan(5));
        var count = BinaryPrimitives.ReadUInt16BigEndian(frame.AsSpan(7));
        var inner = frame[9];
        if (count < 2 || index >= count || inner is not (LinkFraming.Text or LinkFraming.Binary))
        {
            throw new InvalidDataException("A fragment with a bad header.");
        }

        if (index == 0)
        {
            if (_partial is not null)
            {
                throw new InvalidDataException("A new message before the last one ended.");
            }

            _partial = (id, count, 0, inner, new MemoryStream());
        }

        if (_partial is not { } partial || partial.Id != id || partial.Count != count || partial.Next != index || partial.Kind != inner)
        {
            throw new InvalidDataException("A fragment out of order.");
        }

        partial.Data.Write(frame, 10, frame.Length - 10);
        if (partial.Data.Length > LinkFraming.MaxMessage)
        {
            throw new InvalidDataException("A message larger than the link allows.");
        }

        if (index + 1 < count)
        {
            _partial = partial with { Next = index + 1 };
            return null;
        }

        _partial = null;
        return new LinkMessage(inner, partial.Data.ToArray());
    }
}
