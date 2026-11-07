using Runova.ServerCore.Certificates;
using Runova.ServerCore.Certificates.Acme;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Tests.Mapping;

public sealed class CertificateMapperTests
{
    private static readonly DateTimeOffset _now = DateTimeOffset.FromUnixTimeMilliseconds(1_000_000_000_000);

    private static SiteCertificate Row(long notAfter, string source = CertificateViews.AcmeSource) => new()
    {
        SiteId = "shop",
        Source = source,
        DirectoryUrl = AcmeDirectories.LetsEncryptProduction.AbsoluteUri,
        Domains = "[\"shop.example.com\",\"www.shop.example.com\"]",
        KeyType = nameof(AcmeCertificateKeyType.EcdsaP384),
        ChainPem = "-----BEGIN CERTIFICATE-----",
        ProtectedKey = "sealed",
        CertificateId = "aki.serial",
        Issuer = "R11",
        NotBefore = 900_000_000_000,
        NotAfter = notAfter,
        IssuedAt = 900_000_000_001,
        Replaced = "old.serial",
        PreferredChain = "ISRG Root X1",
        AutoRenew = true,
        RenewAt = 1,
        LastAttemptAt = 2,
        LastError = "rate limited",
        LastJobId = Guid.Empty,
        FailedAttempts = 4,
        NextAttemptAt = 5,
        ExplanationUrl = "https://example.com/why",
    };

    [Fact]
    public void A_certificate_reaches_the_app_with_every_field()
    {
        var row = Row(_now.ToUnixTimeMilliseconds() + (long)TimeSpan.FromDays(60).TotalMilliseconds);

        var info = CertificateMapper.ToInfo(row, _now);

        Assert.Equal(
            new CertificateInfo(
                "shop",
                CertificateSource.Acme,
                CertificateState.Valid,
                info.Domains,
                "R11",
                900_000_000_000,
                row.NotAfter,
                true,
                false,
                1,
                2,
                "rate limited",
                Guid.Empty,
                4,
                5,
                null,
                "https://example.com/why"),
            info);
        Assert.Equal(["shop.example.com", "www.shop.example.com"], info.Domains);
    }

    [Fact]
    public void The_state_is_judged_at_the_time_given()
    {
        var day = (long)TimeSpan.FromDays(1).TotalMilliseconds;
        var now = _now.ToUnixTimeMilliseconds();

        Assert.Equal(CertificateState.ExpiringSoon, CertificateMapper.ToInfo(Row(now + (13 * day)), _now).State);
        Assert.Equal(CertificateState.Expired, CertificateMapper.ToInfo(Row(now), _now).State);
        var revoked = Row(now + (60 * day));
        revoked.RevokedAt = now - day;
        var info = CertificateMapper.ToInfo(revoked, _now);
        Assert.Equal(CertificateState.Revoked, info.State);
        Assert.Equal(now - day, info.RevokedAtUnixMs);
    }

    [Fact]
    public void The_source_and_staging_come_from_the_stored_strings()
    {
        Assert.Equal(CertificateSource.Uploaded, CertificateMapper.ToInfo(Row(0, CertificateViews.UploadedSource), _now).Source);
        Assert.Equal(CertificateSource.CloudflareOrigin, CertificateMapper.ToInfo(Row(0, CertificateViews.CloudflareOriginSource), _now).Source);
        Assert.Equal(CertificateSource.Acme, CertificateMapper.ToInfo(Row(0, "something else"), _now).Source);

        var staging = Row(0);
        staging.DirectoryUrl = AcmeDirectories.LetsEncryptStaging.AbsoluteUri;
        Assert.True(CertificateMapper.ToInfo(staging, _now).Staging);
        var uploaded = Row(0, CertificateViews.UploadedSource);
        uploaded.DirectoryUrl = null;
        Assert.False(CertificateMapper.ToInfo(uploaded, _now).Staging);
    }

    [Fact]
    public void A_stored_row_becomes_the_record_the_issuer_works_with()
    {
        var row = Row(1_000_000_500_000);
        row.RevokedAt = 1_000_000_400_000;
        byte[] key = [1, 2, 3];

        var record = CertificateMapper.ToRecord(row, key);

        Assert.Equal("shop", record.Name);
        Assert.Equal(AcmeDirectories.LetsEncryptProduction, record.DirectoryUrl);
        Assert.Equal(["shop.example.com", "www.shop.example.com"], record.Domains);
        Assert.Equal(AcmeCertificateKeyType.EcdsaP384, record.KeyType);
        Assert.Equal("-----BEGIN CERTIFICATE-----", record.ChainPem);
        Assert.Equal(key, record.PrivateKeyPkcs8.ToArray());
        Assert.Equal("aki.serial", record.CertificateId);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(900_000_000_000), record.NotBefore);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(1_000_000_500_000), record.NotAfter);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(900_000_000_001), record.IssuedAt);
        Assert.Equal("old.serial", record.Replaced);
        Assert.Equal("ISRG Root X1", record.PreferredChain);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(1_000_000_400_000), record.RevokedAt);
        row.RevokedAt = null;
        Assert.Null(CertificateMapper.ToRecord(row, key).RevokedAt);
    }

    [Fact]
    public void An_account_row_becomes_an_account_with_the_key_given()
    {
        var row = new AcmeAccountRecord
        {
            DirectoryUrl = AcmeDirectories.LetsEncryptStaging.AbsoluteUri,
            Url = "https://acme.example/acct/1",
            ProtectedKey = "sealed",
            Status = "deactivated",
            Contact = "[\"mailto:ops@example.com\"]",
        };
        using var key = AcmeAccountKey.Generate();

        using var account = CertificateMapper.ToAccount(row, key);

        Assert.Equal(AcmeDirectories.LetsEncryptStaging, account.DirectoryUrl);
        Assert.Equal(new Uri("https://acme.example/acct/1"), account.Url);
        Assert.Same(key, account.Key);
        Assert.Equal(AcmeStatus.Deactivated, account.Status);
        Assert.Equal(["mailto:ops@example.com"], account.Contact);
    }

    [Fact]
    public void Revocation_reasons_map_by_name_and_an_unknown_one_is_unspecified()
    {
        Assert.Equal(AcmeRevocationReason.Unspecified, CertificateMapper.ToAcme(CertificateRevocationReason.Unspecified));
        Assert.Equal(AcmeRevocationReason.KeyCompromise, CertificateMapper.ToAcme(CertificateRevocationReason.KeyCompromise));
        Assert.Equal(AcmeRevocationReason.Superseded, CertificateMapper.ToAcme(CertificateRevocationReason.Superseded));
        Assert.Equal(AcmeRevocationReason.CessationOfOperation, CertificateMapper.ToAcme(CertificateRevocationReason.CessationOfOperation));
        Assert.Equal(AcmeRevocationReason.Unspecified, CertificateMapper.ToAcme((CertificateRevocationReason)99));
    }

    [Fact]
    public void A_renewal_asks_for_the_same_names_key_type_and_chain()
    {
        var existing = new AcmeCertificateRecord
        {
            Name = "shop",
            DirectoryUrl = AcmeDirectories.LetsEncryptProduction,
            Domains = ["shop.example.com"],
            KeyType = AcmeCertificateKeyType.Rsa2048,
            ChainPem = "pem",
            PrivateKeyPkcs8 = new byte[] { 1 },
            CertificateId = "aki.serial",
            NotBefore = _now,
            NotAfter = _now,
            IssuedAt = _now,
            PreferredChain = "ISRG Root X1",
        };

        var request = AcmeMapper.ToRenewal(existing, "aki.serial");

        Assert.Equal("shop", request.Name);
        Assert.Same(existing.Domains, request.Domains);
        Assert.Equal(AcmeCertificateKeyType.Rsa2048, request.KeyType);
        Assert.Equal("ISRG Root X1", request.PreferredChain);
        Assert.Equal("aki.serial", request.Replaces);
        Assert.False(request.PreferDns01);
        Assert.Null(request.Profile);
        Assert.Null(AcmeMapper.ToRenewal(existing, null).Replaces);
    }
}
