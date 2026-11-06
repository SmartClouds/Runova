using System.Formats.Asn1;
using System.Security.Cryptography.X509Certificates;

namespace Runova.Monitoring.Contracts;

/// <summary>Reads what a client certificate says about its node.</summary>
public static class NodeCertificates
{
    /// <summary>The node id in the certificate's SAN URI, or null when it has none of ours.</summary>
    public static long? NodeIdOf(X509Certificate2 certificate)
    {
        foreach (var extension in certificate.Extensions)
        {
            if (extension is not X509SubjectAlternativeNameExtension san)
            {
                continue;
            }

            foreach (var uri in ReadUris(san.RawData))
            {
                if (NodeIdentity.TryParse(uri, out var id))
                {
                    return id;
                }
            }
        }

        return null;
    }

    /// <summary>The uniformResourceIdentifier entries ([6] IA5String) of a SAN extension.</summary>
    public static IEnumerable<string> ReadUris(byte[] sanDer)
    {
        var uris = new List<string>();
        var reader = new AsnReader(sanDer, AsnEncodingRules.DER);
        var names = reader.ReadSequence();
        var uriTag = new Asn1Tag(TagClass.ContextSpecific, 6);
        while (names.HasData)
        {
            var tag = names.PeekTag();
            if (tag.HasSameClassAndValue(uriTag))
            {
                uris.Add(names.ReadCharacterString(UniversalTagNumber.IA5String, uriTag));
            }
            else
            {
                names.ReadEncodedValue();
            }
        }

        return uris;
    }
}
