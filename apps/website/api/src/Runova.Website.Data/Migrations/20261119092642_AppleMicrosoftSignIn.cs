using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Runova.Website.Data.Migrations;

/// <inheritdoc />
public partial class AppleMicrosoftSignIn : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<string>(
            name: "AppleBundleId",
            table: "SignInSettings",
            type: "character varying(300)",
            maxLength: 300,
            nullable: false,
            defaultValue: "com.runovahq.app");

        migrationBuilder.AddColumn<bool>(
            name: "AppleEnabled",
            table: "SignInSettings",
            type: "boolean",
            nullable: false,
            defaultValue: false);

        migrationBuilder.AddColumn<string>(
            name: "AppleKeyId",
            table: "SignInSettings",
            type: "character varying(20)",
            maxLength: 20,
            nullable: true);

        migrationBuilder.AddColumn<string>(
            name: "ApplePrivateKeySealed",
            table: "SignInSettings",
            type: "text",
            nullable: true);

        migrationBuilder.AddColumn<string>(
            name: "AppleServicesId",
            table: "SignInSettings",
            type: "character varying(300)",
            maxLength: 300,
            nullable: true);

        migrationBuilder.AddColumn<string>(
            name: "AppleTeamId",
            table: "SignInSettings",
            type: "character varying(20)",
            maxLength: 20,
            nullable: true);

        migrationBuilder.AddColumn<string>(
            name: "MicrosoftClientId",
            table: "SignInSettings",
            type: "character varying(300)",
            maxLength: 300,
            nullable: true);

        migrationBuilder.AddColumn<string>(
            name: "MicrosoftClientSecretSealed",
            table: "SignInSettings",
            type: "text",
            nullable: true);

        migrationBuilder.AddColumn<bool>(
            name: "MicrosoftEnabled",
            table: "SignInSettings",
            type: "boolean",
            nullable: false,
            defaultValue: false);

        migrationBuilder.UpdateData(
            table: "SignInSettings",
            keyColumn: "Id",
            keyValue: 1,
            columns: new[] { "AppleBundleId", "AppleEnabled", "AppleKeyId", "ApplePrivateKeySealed", "AppleServicesId", "AppleTeamId", "MicrosoftClientId", "MicrosoftClientSecretSealed", "MicrosoftEnabled" },
            values: new object[] { "com.runovahq.app", true, null, null, null, null, null, null, true });
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn(
            name: "AppleBundleId",
            table: "SignInSettings");

        migrationBuilder.DropColumn(
            name: "AppleEnabled",
            table: "SignInSettings");

        migrationBuilder.DropColumn(
            name: "AppleKeyId",
            table: "SignInSettings");

        migrationBuilder.DropColumn(
            name: "ApplePrivateKeySealed",
            table: "SignInSettings");

        migrationBuilder.DropColumn(
            name: "AppleServicesId",
            table: "SignInSettings");

        migrationBuilder.DropColumn(
            name: "AppleTeamId",
            table: "SignInSettings");

        migrationBuilder.DropColumn(
            name: "MicrosoftClientId",
            table: "SignInSettings");

        migrationBuilder.DropColumn(
            name: "MicrosoftClientSecretSealed",
            table: "SignInSettings");

        migrationBuilder.DropColumn(
            name: "MicrosoftEnabled",
            table: "SignInSettings");
    }
}
