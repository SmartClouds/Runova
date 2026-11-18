namespace Runova.ServerCore.Traffic;

/// <summary>
/// A fixed number of the most recently used entries; adding one more drops the one used longest
/// ago. Lookups and additions are O(1) and safe from several threads.
/// </summary>
internal sealed class LruCache<TKey, TValue>
    where TKey : notnull
{
    private readonly int _capacity;
    private readonly Dictionary<TKey, LinkedListNode<(TKey Key, TValue Value)>> _entries;
    private readonly LinkedList<(TKey Key, TValue Value)> _order = new();
    private readonly Lock _gate = new();

    public LruCache(int capacity)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(capacity, 1);
        _capacity = capacity;
        _entries = new Dictionary<TKey, LinkedListNode<(TKey, TValue)>>(capacity);
    }

    public int Count
    {
        get
        {
            lock (_gate)
            {
                return _entries.Count;
            }
        }
    }

    public bool TryGet(TKey key, out TValue value)
    {
        lock (_gate)
        {
            if (_entries.TryGetValue(key, out var node))
            {
                _order.Remove(node);
                _order.AddLast(node);
                value = node.Value.Value;
                return true;
            }
        }

        value = default!;
        return false;
    }

    public void Set(TKey key, TValue value)
    {
        lock (_gate)
        {
            if (_entries.TryGetValue(key, out var node))
            {
                _order.Remove(node);
                node.Value = (key, value);
                _order.AddLast(node);
                return;
            }

            if (_entries.Count >= _capacity && _order.First is { } oldest)
            {
                _order.RemoveFirst();
                _entries.Remove(oldest.Value.Key);
            }

            _entries[key] = _order.AddLast((key, value));
        }
    }

    public void Clear()
    {
        lock (_gate)
        {
            _entries.Clear();
            _order.Clear();
        }
    }
}
