import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageUpdateRequest } from '../../shared/apiTypes';
import { stubRegistry } from '../../test/main/fakeRegistry';
import { tempDir, writeTree } from '../../test/main/fixtures';

/**
 * An Android project keeps its versions in a version catalog, in the build scripts, or both, and
 * nothing has to run for an update: Gradle picks the new version up from the file on its next build.
 */

const { gradleAdapter } = await import('./gradleAdapter');

const metadata = (versions: string[]) =>
  `<metadata><versioning><versions>${versions.map((v) => `<version>${v}</version>`).join('')}</versions></versioning></metadata>`;

const google = (group: string, artifact: string) =>
  `https://dl.google.com/dl/android/maven2/${group.replaceAll('.', '/')}/${artifact}/maven-metadata.xml`;
const central = (group: string, artifact: string) =>
  `https://repo1.maven.org/maven2/${group.replaceAll('.', '/')}/${artifact}/maven-metadata.xml`;
const portal = (id: string) =>
  `https://plugins.gradle.org/m2/${id.replaceAll('.', '/')}/${id}.gradle.plugin/maven-metadata.xml`;

let root = '';

beforeEach(() => {
  root = tempDir('runova-gradle-adapter-');
  stubRegistry({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function request(overrides: Partial<PackageUpdateRequest> = {}): PackageUpdateRequest {
  return {
    ecosystem: 'kotlin',
    name: 'junit:junit',
    targetVersion: '4.13.2',
    manifestPath: join(root, 'app', 'build.gradle.kts'),
    ...overrides,
  };
}

describe('detect', () => {
  it.each(['build.gradle', 'app/build.gradle.kts', 'gradle/libs.versions.toml'])(
    'finds %s',
    async (file) => {
      writeTree(root, { [file]: '' });
      await expect(gradleAdapter.detect(root)).resolves.toBe(true);
    },
  );

  it.each(['node_modules', 'build', '.gradle'])('ignores what sits under %s', async (dir) => {
    writeTree(root, { [`${dir}/build.gradle`]: '' });
    await expect(gradleAdapter.detect(root)).resolves.toBe(false);
  });
});

describe('listing build scripts', () => {
  it('reads Kotlin DSL coordinates and tells test scopes apart', async () => {
    writeTree(root, {
      'app/build.gradle.kts': `dependencies {
    val bom = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(bom)
    implementation("androidx.compose.ui:ui")
    implementation("net.java.dev.jna:jna:5.17.0@aar")
    // implementation("com.old:gone:1.0.0")
    testImplementation("net.java.dev.jna:jna:5.17.0")
    testImplementation("junit:junit:4.13.1")
    debugImplementation("com.example:debug-tool:1.0.0")
    implementation("com.example:dynamic:1.+")
    implementation("com.example:variable:$someVersion")
}
`,
    });

    const [section] = await gradleAdapter.listPackages(root);

    expect(section).toMatchObject({ ecosystem: 'kotlin', manager: 'gradle', status: 'ok' });
    // jna is declared twice but is one row, and a row used by the app itself is not a dev one.
    expect(section.packages.map((p) => [p.name, p.currentVersion, p.isDev])).toEqual([
      ['androidx.compose:compose-bom', '2026.09.00', false],
      ['com.example:debug-tool', '1.0.0', true],
      ['junit:junit', '4.13.1', true],
      ['net.java.dev.jna:jna', '5.17.0', false],
    ]);
    expect(section.packages[0].projectLabel).toBe('app');
  });

  it('reads Groovy coordinates', async () => {
    writeTree(root, {
      'build.gradle': `buildscript {
  dependencies { classpath 'com.android.tools.build:gradle:8.0.0' }
}
dependencies {
  implementation 'com.squareup.okhttp3:okhttp:4.12.0'
}
`,
    });

    const [section] = await gradleAdapter.listPackages(root);

    expect(section.packages.map((p) => p.name)).toEqual([
      'com.android.tools.build:gradle',
      'com.squareup.okhttp3:okhttp',
    ]);
  });

  it('reads plugin versions from both DSLs, including the kotlin() shorthand', async () => {
    writeTree(root, {
      'build.gradle.kts': `plugins {
    id("com.android.application") version "9.2.1" apply false
    kotlin("android") version "2.4.0" apply false
    id("no.version.here")
}
`,
      'sub/build.gradle': `plugins {
    id 'org.groovy.plugin' version '1.0.0'
}
`,
    });

    const [section] = await gradleAdapter.listPackages(root);

    expect(section.packages.map((p) => [p.name, p.currentVersion])).toEqual([
      ['com.android.application', '9.2.1'],
      ['org.groovy.plugin', '1.0.0'],
      ['org.jetbrains.kotlin.android', '2.4.0'],
    ]);
  });

  it('adds no section for a build script with nothing versioned', async () => {
    writeTree(root, { 'build.gradle.kts': 'tasks.register("x")\n' });

    await expect(gradleAdapter.listPackages(root)).resolves.toEqual([]);
  });
});

describe('listing a version catalog', () => {
  const CATALOG = `[versions]
agp = "8.5.0"
core = "1.13.0"
strict = { strictly = "1.0" }

[libraries]
core-ktx = { module = "androidx.core:core-ktx", version.ref = "core" }
core-other = { group = "androidx.core", name = "core-other", version.ref = "core" }
okhttp = "com.squareup.okhttp3:okhttp:4.12.0"
inline = { module = "com.example:inline", version = "2.0.0" }
versionless = { module = "com.example:from-bom" }
hard = { module = "com.example:hard", version.ref = "strict" }

[plugins]
android-app = { id = "com.android.application", version.ref = "agp" }
serial = "org.jetbrains.kotlin.plugin.serialization:2.0.0"
`;

  it('resolves references and every library form', async () => {
    writeTree(root, { 'gradle/libs.versions.toml': CATALOG });

    const [section] = await gradleAdapter.listPackages(root);

    expect(section.packages.map((p) => [p.name, p.currentVersion])).toEqual([
      ['androidx.core:core-ktx', '1.13.0'],
      ['androidx.core:core-other', '1.13.0'],
      ['com.android.application', '8.5.0'],
      ['com.example:inline', '2.0.0'],
      ['com.squareup.okhttp3:okhttp', '4.12.0'],
      ['org.jetbrains.kotlin.plugin.serialization', '2.0.0'],
    ]);
    expect(section.packages[0].manifestPath).toBe(join(root, 'gradle', 'libs.versions.toml'));
  });
});

describe('looking up versions', () => {
  it('asks Google Maven for androidx and Maven Central for the rest', async () => {
    writeTree(root, {
      'build.gradle.kts': `dependencies {
  implementation("androidx.core:core-ktx:1.13.0")
  implementation("com.squareup.okhttp3:okhttp:4.12.0")
}`,
    });
    stubRegistry({
      [google('androidx.core', 'core-ktx')]: metadata(['1.13.0', '1.15.0', '1.16.0-alpha01']),
      [central('com.squareup.okhttp3', 'okhttp')]: metadata(['4.12.0', '5.0.0']),
    });

    const [section] = await gradleAdapter.listPackages(root);

    expect(section.packages.map((p) => [p.name, p.latestVersion, p.isOutdated])).toEqual([
      ['androidx.core:core-ktx', '1.15.0', true],
      ['com.squareup.okhttp3:okhttp', '5.0.0', true],
    ]);
  });

  it('falls through to the next repository on a 404', async () => {
    writeTree(root, {
      'build.gradle.kts': 'dependencies { implementation("androidx.fork:thing:1.0.0") }',
    });
    stubRegistry({ [central('androidx.fork', 'thing')]: metadata(['1.1.0']) });

    const [section] = await gradleAdapter.listPackages(root);

    expect(section.packages[0].latestVersion).toBe('1.1.0');
  });

  it('finds plugins through their marker artifact', async () => {
    writeTree(root, {
      'build.gradle.kts': 'plugins { id("org.jetbrains.kotlin.android") version "2.0.0" }',
    });
    stubRegistry({ [portal('org.jetbrains.kotlin.android')]: metadata(['2.0.0', '2.1.0']) });

    const [section] = await gradleAdapter.listPackages(root);

    expect(section.packages[0]).toMatchObject({ latestVersion: '2.1.0', isOutdated: true });
  });

  it('does not look up the plugin Flutter ships itself', async () => {
    writeTree(root, {
      'settings.gradle.kts': 'plugins { id("dev.flutter.flutter-plugin-loader") version "1.0.0" }',
    });
    const requests = stubRegistry({});

    const [section] = await gradleAdapter.listPackages(root);

    expect(section.packages[0]).toMatchObject({ latestVersion: '1.0.0', isOutdated: false });
    expect(section.message).toBeNull();
    expect(requests).toEqual([]);
  });

  it('leaves the latest unknown for something no repository has', async () => {
    writeTree(root, {
      'build.gradle.kts': 'dependencies { implementation("com.corp:private:1.0.0") }',
    });

    const [section] = await gradleAdapter.listPackages(root);

    expect(section.packages[0].latestVersion).toBeNull();
    expect(section.message).toBe('The latest version of 1 package could not be looked up.');
  });

  it('keeps the -android flavor', async () => {
    writeTree(root, {
      'build.gradle.kts':
        'dependencies { implementation("com.google.guava:guava:32.0.0-android") }',
    });
    stubRegistry({
      [central('com.google.guava', 'guava')]: metadata(['33.0.0-android', '33.1.0-jre']),
    });

    const [section] = await gradleAdapter.listPackages(root);

    expect(section.packages[0].latestVersion).toBe('33.0.0-android');
  });
});

describe('updating', () => {
  it('rewrites every declaration of a coordinate and only that', async () => {
    const manifestPath = join(root, 'app', 'build.gradle.kts');
    writeTree(root, {
      'app/build.gradle.kts': `dependencies {\r
    implementation("net.java.dev.jna:jna:5.17.0@aar")\r
    testImplementation("net.java.dev.jna:jna:5.17.0")\r
    testImplementation("junit:junit:4.13.1")\r
}\r
`,
    });

    const result = await gradleAdapter.updatePackages(
      root,
      [request({ name: 'net.java.dev.jna:jna', targetVersion: '5.18.0', manifestPath })],
      () => undefined,
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(manifestPath, 'utf-8')).toBe(`dependencies {\r
    implementation("net.java.dev.jna:jna:5.18.0@aar")\r
    testImplementation("net.java.dev.jna:jna:5.18.0")\r
    testImplementation("junit:junit:4.13.1")\r
}\r
`);
  });

  it('rewrites a plugin version', async () => {
    const manifestPath = join(root, 'build.gradle.kts');
    writeTree(root, {
      'build.gradle.kts':
        'plugins {\n  id("com.android.application") version "9.2.1" apply false\n}\n',
    });

    await gradleAdapter.updatePackages(
      root,
      [request({ name: 'com.android.application', targetVersion: '9.3.0', manifestPath })],
      () => undefined,
    );

    expect(readFileSync(manifestPath, 'utf-8')).toContain('version "9.3.0" apply false');
  });

  it('moves the shared catalog version when a referencing library is updated', async () => {
    const manifestPath = join(root, 'gradle', 'libs.versions.toml');
    writeTree(root, {
      'gradle/libs.versions.toml': `[versions]
core = "1.13.0"
[libraries]
a = { module = "androidx.core:a", version.ref = "core" }
b = { module = "androidx.core:b", version.ref = "core" }
c = "com.x:c:1.0.0"
`,
    });

    await gradleAdapter.updatePackages(
      root,
      [
        request({ name: 'androidx.core:a', targetVersion: '1.15.0', manifestPath }),
        request({ name: 'androidx.core:b', targetVersion: '1.14.0', manifestPath }),
        request({ name: 'com.x:c', targetVersion: '2.0.0', manifestPath }),
      ],
      () => undefined,
    );

    const updated = readFileSync(manifestPath, 'utf-8');
    // Two libraries share one version, so the newer of the two wins rather than the last asked.
    expect(updated).toContain('core = "1.15.0"');
    expect(updated).toContain('"com.x:c:2.0.0"');
  });

  it('reports a package the file no longer has', async () => {
    const manifestPath = join(root, 'build.gradle.kts');
    writeTree(root, { 'build.gradle.kts': 'dependencies {}\n' });

    const result = await gradleAdapter.updatePackages(
      root,
      [request({ manifestPath })],
      () => undefined,
    );

    expect(result.ok).toBe(false);
    expect(result.results[0].message).toContain('junit:junit');
  });
});
