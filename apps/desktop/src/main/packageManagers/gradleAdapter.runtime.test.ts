import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageUpdateRequest, RuntimeUpdateRequest } from '../../shared/apiTypes';
import { stubRegistry } from '../../test/main/fakeRegistry';
import { tempDir, writeTree } from '../../test/main/fixtures';

/**
 * Versions held in variables, the Gradle and Android versions a project asks for, and what goes up
 * for dependency alerts. A variable can sit in another file from the dependency that uses it, so
 * an update has to change the place the value is written rather than the place it is used.
 */

const feedState = vi.hoisted(() => ({
  gradle: '9.9.0' as string | null,
  androidApi: '37' as string | null,
}));

vi.mock('./runtimeFeeds', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtimeFeeds')>();
  return {
    ...actual,
    runtimeFeeds: {
      gradle: async () => feedState.gradle,
      androidApi: async () => feedState.androidApi,
    },
  };
});

const { gradleAdapter } = await import('./gradleAdapter');

const has = { installedVersion: async () => null };
let root = '';

beforeEach(() => {
  root = tempDir('runova-gradle-runtime-');
  feedState.gradle = '9.9.0';
  feedState.androidApi = '37';
  stubRegistry({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function pkg(overrides: Partial<PackageUpdateRequest>): PackageUpdateRequest {
  return {
    ecosystem: 'kotlin',
    name: 'io.ktor:ktor-client',
    targetVersion: '3.0.0',
    manifestPath: join(root, 'build.gradle.kts'),
    ...overrides,
  };
}

function runtime(overrides: Partial<RuntimeUpdateRequest>): RuntimeUpdateRequest {
  return {
    ecosystem: 'kotlin',
    source: 'gradle-wrapper',
    kind: 'gradle',
    manifestPath: join(root, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
    targetVersion: '9.9.0',
    ...overrides,
  };
}

async function versions(): Promise<[string, string][]> {
  const [section] = await gradleAdapter.listPackages(root);
  return section.packages.map((p) => [p.name, p.currentVersion]);
}

describe('versions held in variables', () => {
  it.each([
    [
      'a Kotlin val',
      'val ktor = "2.3.0"\ndependencies { implementation("io.ktor:ktor-client:$ktor") }',
    ],
    [
      'braces',
      'val ktor = "2.3.0"\ndependencies { implementation("io.ktor:ktor-client:${ktor}") }',
    ],
    [
      'a typed val',
      'val ktor: String = "2.3.0"\ndependencies { implementation("io.ktor:ktor-client:$ktor") }',
    ],
    [
      'a by extra val',
      'val ktor by extra("2.3.0")\ndependencies { implementation("io.ktor:ktor-client:$ktor") }',
    ],
    [
      'extra[]',
      'extra["ktor"] = "2.3.0"\ndependencies { implementation("io.ktor:ktor-client:${extra["ktor"]}") }',
    ],
  ])('resolves %s', async (_form, script) => {
    writeTree(root, { 'build.gradle.kts': script });

    await expect(versions()).resolves.toEqual([['io.ktor:ktor-client', '2.3.0']]);
  });

  it.each([
    ['def', 'def ktor = \'2.3.0\'\ndependencies { implementation "io.ktor:ktor-client:$ktor" }'],
    ['ext.', 'ext.ktor = \'2.3.0\'\ndependencies { implementation "io.ktor:ktor-client:$ktor" }'],
    [
      'an ext block',
      'ext {\n  ktor = \'2.3.0\'\n}\ndependencies { implementation "io.ktor:ktor-client:${ktor}" }',
    ],
    [
      'project.ext',
      'ext.ktor = \'2.3.0\'\ndependencies { implementation "io.ktor:ktor-client:${project.ext.ktor}" }',
    ],
  ])('resolves Groovy %s', async (_form, script) => {
    writeTree(root, { 'build.gradle': script });

    await expect(versions()).resolves.toEqual([['io.ktor:ktor-client', '2.3.0']]);
  });

  it('resolves gradle.properties, also through property()', async () => {
    writeTree(root, {
      'gradle.properties': '# versions\nktor_version=2.3.0\nother : 1.1.0\nnot_a_version=true\n',
      'build.gradle.kts': `val ktor_version: String by project
dependencies {
  implementation("io.ktor:ktor-client:$ktor_version")
  implementation("com.x:other:\${property("other")}")
  implementation("com.x:flag:$not_a_version")
}`,
    });

    await expect(versions()).resolves.toEqual([
      ['com.x:other', '1.1.0'],
      ['io.ktor:ktor-client', '2.3.0'],
    ]);
  });

  it('finds a value the root project sets for a module', async () => {
    writeTree(root, {
      'build.gradle': "buildscript {\n  ext.kotlin_version = '1.9.0'\n}\n",
      'app/build.gradle':
        'dependencies { implementation "org.jetbrains.kotlin:kotlin-stdlib:$kotlin_version"\n implementation "com.x:y:${rootProject.ext.kotlin_version}" }',
    });

    const [section] = await gradleAdapter.listPackages(root);

    expect(section.packages.map((p) => [p.name, p.currentVersion, p.projectLabel])).toEqual([
      ['com.x:y', '1.9.0', 'app'],
      ['org.jetbrains.kotlin:kotlin-stdlib', '1.9.0', 'app'],
    ]);
  });

  it('never looks into a sibling module for a value', async () => {
    writeTree(root, {
      'a/build.gradle': "ext.shared = '1.0.0'\n",
      'b/build.gradle': 'dependencies { implementation "com.x:y:$shared" }\n',
    });

    await expect(gradleAdapter.listPackages(root)).resolves.toEqual([]);
  });

  it('leaves out a variable that is computed', async () => {
    writeTree(root, {
      'build.gradle.kts':
        'val v = computeIt()\ndependencies { implementation("com.x:y:$v") }\n// val v = "1.0.0"\n',
    });

    await expect(gradleAdapter.listPackages(root)).resolves.toEqual([]);
  });

  it('resolves a plugin version held in a variable', async () => {
    writeTree(root, {
      'gradle.properties': 'kotlinVersion=2.0.0\n',
      'build.gradle.kts': `plugins {
  id("com.x.quoted") version "$kotlinVersion"
  id("com.x.bare") version kotlinVersion
  kotlin("android") version kotlinVersion
  id("com.x.catalog") version libs.versions.x.get()
}`,
    });

    await expect(versions()).resolves.toEqual([
      ['com.x.bare', '2.0.0'],
      ['com.x.quoted', '2.0.0'],
      ['org.jetbrains.kotlin.android', '2.0.0'],
    ]);
  });

  it('updates the variable where it is written, in the same file', async () => {
    const script =
      'val ktor = "2.3.0" // pin\ndependencies { implementation("io.ktor:ktor-client:$ktor") }\n';
    writeTree(root, { 'build.gradle.kts': script });

    const result = await gradleAdapter.updatePackages(root, [pkg({})], () => undefined);

    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, 'build.gradle.kts'), 'utf-8')).toBe(
      script.replace('"2.3.0"', '"3.0.0"'),
    );
  });

  it('updates a variable that lives in another file', async () => {
    const properties = '# keep\r\nktor=2.3.0\r\nother=1.0.0\r\n';
    const script = 'dependencies { implementation("io.ktor:ktor-client:$ktor") }\n';
    writeTree(root, { 'gradle.properties': properties, 'app/build.gradle.kts': script });

    await gradleAdapter.updatePackages(
      root,
      [pkg({ manifestPath: join(root, 'app', 'build.gradle.kts') })],
      () => undefined,
    );

    expect(readFileSync(join(root, 'gradle.properties'), 'utf-8')).toBe(
      properties.replace('2.3.0', '3.0.0'),
    );
    expect(readFileSync(join(root, 'app', 'build.gradle.kts'), 'utf-8')).toBe(script);
  });

  it('keeps the newest when two modules move one shared variable', async () => {
    writeTree(root, {
      'gradle.properties': 'ktor=2.3.0\n',
      'a/build.gradle.kts': 'dependencies { implementation("io.ktor:ktor-a:$ktor") }\n',
      'b/build.gradle.kts': 'dependencies { implementation("io.ktor:ktor-b:$ktor") }\n',
    });

    await gradleAdapter.updatePackages(
      root,
      [
        pkg({ name: 'io.ktor:ktor-a', manifestPath: join(root, 'a', 'build.gradle.kts') }),
        pkg({
          name: 'io.ktor:ktor-b',
          targetVersion: '2.9.0',
          manifestPath: join(root, 'b', 'build.gradle.kts'),
        }),
      ],
      () => undefined,
    );

    expect(readFileSync(join(root, 'gradle.properties'), 'utf-8')).toBe('ktor=3.0.0\n');
  });
});

describe('the Gradle wrapper', () => {
  const WRAPPER =
    'distributionBase=GRADLE_USER_HOME\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-8.9-bin.zip\n';

  function project(properties = WRAPPER): void {
    writeTree(root, {
      'build.gradle.kts': '',
      'gradle/wrapper/gradle-wrapper.properties': properties,
    });
  }

  it('is listed with the project that owns it', async () => {
    project();

    const [section] = await gradleAdapter.listPackages(root);

    expect(section.runtimes).toEqual([
      {
        kind: 'gradle',
        source: 'gradle-wrapper',
        declared: '8.9',
        currentVersion: '8.9',
        latestVersion: '9.9.0',
        isOutdated: true,
        nextDeclared: '9.9.0',
        requires: null,
        manifestPath: join(root, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
        projectLabel: root.split(/[\\/]/).at(-1),
      },
    ]);
  });

  it('is rewritten in place', async () => {
    project();

    const result = await gradleAdapter.updateRuntime(root, runtime({}), has);

    expect(result.ok).toBe(true);
    expect(
      readFileSync(join(root, 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'utf-8'),
    ).toBe(WRAPPER.replace('gradle-8.9-bin', 'gradle-9.9.0-bin'));
  });

  it('will not change a wrapper pinned by checksum, which would stop matching', async () => {
    project(`${WRAPPER}distributionSha256Sum=abc\n`);

    const [section] = await gradleAdapter.listPackages(root);

    expect(section.runtimes[0]).toMatchObject({ isOutdated: true, nextDeclared: null });
  });
});

describe('Android SDK levels', () => {
  const KTS = `android {
    // compileSdk = 21
    compileSdk = 34
    defaultConfig {
        minSdk = 26
        targetSdk = 33
    }
}
`;

  it('lists compile and target levels but not the minimum', async () => {
    writeTree(root, { 'app/build.gradle.kts': KTS });

    const [section] = await gradleAdapter.listPackages(root);

    expect(section.runtimes.map((t) => [t.kind, t.source, t.declared, t.nextDeclared])).toEqual([
      ['android', 'android-compile-sdk', '34', '37'],
      ['android', 'android-target-sdk', '33', '37'],
    ]);
  });

  it('reads the Groovy forms', async () => {
    writeTree(root, {
      'build.gradle': 'android {\n  compileSdkVersion 33\n  targetSdkVersion 33\n}\n',
    });

    const [section] = await gradleAdapter.listPackages(root);

    expect(section.runtimes.map((t) => t.source)).toEqual([
      'android-compile-sdk',
      'android-target-sdk',
    ]);
  });

  it('leaves out a level that comes from somewhere else', async () => {
    writeTree(root, {
      'build.gradle.kts': 'android {\n  compileSdk = flutter.compileSdkVersion\n}\n',
    });

    await expect(gradleAdapter.listPackages(root)).resolves.toEqual([]);
  });

  it('rewrites the live value, not the commented one', async () => {
    const manifestPath = join(root, 'app', 'build.gradle.kts');
    writeTree(root, { 'app/build.gradle.kts': KTS });

    const result = await gradleAdapter.updateRuntime(
      root,
      runtime({
        source: 'android-compile-sdk',
        kind: 'android',
        manifestPath,
        targetVersion: '37',
      }),
      has,
    );

    expect(result).toEqual({ ok: true, message: 'Updated 34 to 37.' });
    expect(readFileSync(manifestPath, 'utf-8')).toBe(
      KTS.replace('compileSdk = 34', 'compileSdk = 37'),
    );
  });
});

describe('readInventory', () => {
  it('sends libraries under maven without their flavor, and no plugins', async () => {
    writeTree(root, {
      'gradle.properties': 'ktor=2.3.0\n',
      'build.gradle.kts': `plugins { id("com.android.application") version "9.2.1" }
dependencies {
  implementation("com.google.guava:guava:32.0.0-android")
  implementation("io.ktor:ktor-client:$ktor")
  testImplementation("junit:junit:4.13.2")
  implementation("androidx.core:core:1.0.0-alpha01")
}`,
    });
    const requests = stubRegistry({});

    const inventory = await gradleAdapter.readInventory(root);

    expect(inventory).toEqual([
      { ecosystem: 'maven', name: 'androidx.core:core', version: '1.0.0-alpha01', dev: false },
      { ecosystem: 'maven', name: 'com.google.guava:guava', version: '32.0.0', dev: false },
      { ecosystem: 'maven', name: 'io.ktor:ktor-client', version: '2.3.0', dev: false },
      { ecosystem: 'maven', name: 'junit:junit', version: '4.13.2', dev: true },
    ]);
    expect(requests).toEqual([]);
  });
});
