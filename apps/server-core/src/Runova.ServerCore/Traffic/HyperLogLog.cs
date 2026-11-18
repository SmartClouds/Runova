using System.Buffers.Binary;
using System.IO.Hashing;
using System.Numerics;
using System.Security.Cryptography;

namespace Runova.ServerCore.Traffic;

/// <summary>
/// Counts distinct visitors in 4 KB, whatever their number (E109): HyperLogLog with precision 12,
/// about 1.6% standard error. Sketches of days merge into the count of any range, so a visitor who
/// comes back on another day is counted once. Small counts use linear counting, which is close to
/// exact. Not thread-safe.
/// </summary>
internal sealed class HyperLogLog
{
    public const int Precision = 12;

    public const int Size = 1 << Precision;

    private readonly byte[] _registers;

    public HyperLogLog()
        : this(new byte[Size])
    {
    }

    private HyperLogLog(byte[] registers) => _registers = registers;

    /// <summary>A sketch read back from <see cref="ToArray"/>; anything else gives an empty one.</summary>
    public static HyperLogLog From(byte[]? bytes) =>
        bytes is { Length: Size } ? new HyperLogLog((byte[])bytes.Clone()) : new HyperLogLog();

    /// <param name="hash">A 64-bit hash of the visitor (XxHash64). It is mixed once more, so even small ids spread over the registers.</param>
    public void Add(ulong hash)
    {
        hash = Mix(hash);
        var index = (int)(hash >> (64 - Precision));
        // The low bit set past the index keeps the rank within 64 - Precision + 1.
        var rest = (hash << Precision) | (1UL << (Precision - 1));
        var rank = (byte)(BitOperations.LeadingZeroCount(rest) + 1);
        if (rank > _registers[index])
        {
            _registers[index] = rank;
        }
    }

    public void Merge(HyperLogLog other)
    {
        ArgumentNullException.ThrowIfNull(other);
        for (var i = 0; i < Size; i++)
        {
            if (other._registers[i] > _registers[i])
            {
                _registers[i] = other._registers[i];
            }
        }
    }

    public long Estimate()
    {
        double sum = 0;
        var zeros = 0;
        foreach (var register in _registers)
        {
            sum += Math.ScaleB(1, -register);
            if (register == 0)
            {
                zeros++;
            }
        }

        const double m = Size;
        var alpha = 0.7213 / (1 + (1.079 / m));
        var estimate = alpha * m * m / sum;
        if (estimate <= 2.5 * m && zeros > 0)
        {
            estimate = m * Math.Log(m / zeros);
        }

        return (long)Math.Round(estimate);
    }

    public byte[] ToArray() => (byte[])_registers.Clone();

    /// <summary>MurmurHash3's 64-bit finalizer: every bit of the input moves every bit of the output.</summary>
    private static ulong Mix(ulong value)
    {
        value ^= value >> 33;
        value *= 0xff51afd7ed558ccdUL;
        value ^= value >> 33;
        value *= 0xc4ceb9fe1a85ec53UL;
        value ^= value >> 33;
        return value;
    }
}

/// <summary>
/// A visitor is XxHash64 of a secret salt of this core's own, the address and the user agent
/// (E109): the same person on the same browser is the same visitor, and the statistics never hold
/// an address. The salt never leaves the data folder, so the hashes cannot be matched to addresses
/// anywhere else. Safe from several threads.
/// </summary>
internal sealed class VisitorHasher
{
    public const string SaltFile = "traffic-salt";

    private const int SaltBytes = 32;

    private readonly byte[] _salt;
    private readonly XxHash64 _hash;
    private readonly Lock _gate = new();

    public VisitorHasher(byte[] salt)
    {
        ArgumentNullException.ThrowIfNull(salt);
        _salt = (byte[])salt.Clone();
        _hash = new XxHash64(salt.Length >= 8 ? BinaryPrimitives.ReadInt64LittleEndian(salt) : 0);
    }

    public ulong Hash(ReadOnlySpan<byte> address, ReadOnlySpan<byte> agent)
    {
        lock (_gate)
        {
            _hash.Reset();
            _hash.Append(_salt);
            _hash.Append(address);
            // No address holds a zero byte, so where the address ends is never in doubt.
            _hash.Append([0]);
            _hash.Append(agent);
            return _hash.GetCurrentHashAsUInt64();
        }
    }

    /// <summary>The salt in the folder, made (owner-only) on first use.</summary>
    public static byte[] LoadSalt(string folder)
    {
        ArgumentNullException.ThrowIfNull(folder);
        var path = Path.Combine(folder, SaltFile);
        if (File.Exists(path) && File.ReadAllBytes(path) is { Length: SaltBytes } existing)
        {
            return existing;
        }

        if (OperatingSystem.IsWindows())
        {
            Directory.CreateDirectory(folder);
        }
        else if (!Directory.Exists(folder))
        {
            Directory.CreateDirectory(folder, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        var salt = RandomNumberGenerator.GetBytes(SaltBytes);
        var temporary = path + "." + Guid.NewGuid().ToString("N");
        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }

        using (var stream = new FileStream(temporary, options))
        {
            stream.Write(salt);
        }

        File.Move(temporary, path, overwrite: true);
        return salt;
    }
}
