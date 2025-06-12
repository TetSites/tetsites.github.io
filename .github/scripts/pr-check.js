const { Octokit } = require("@octokit/rest");
const process = require("process");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");

// GitHub environment variables set automatically by Actions
const prNumber = process.env.GITHUB_REF?.split("/")[2];
const repoFull = process.env.GITHUB_REPOSITORY;
const [owner, repo] = repoFull.split("/");

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

async function run() {
  if (!prNumber) {
    console.log("No PR number found, skipping.");
    return;
  }

  console.log(`Checking PR #${prNumber} in ${repoFull}`);

  const { data: pr } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  const prAuthor = pr.user.login;
  const baseRef = pr.base.ref;

  console.log(`PR author is @${prAuthor}`);

  const { data: files } = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
  });

  let newFolders = new Set();
  let touchedFolders = new Set();
  let allowlistEdits = [];

  for (const file of files) {
    const filePath = file.filename;
    const status = file.status;
    const parts = filePath.split("/");
    if (parts.length < 2) continue;

    const folder = parts[0];

    if (filePath.startsWith("allowlist/")) {
      allowlistEdits.push(filePath);
    } else {
      if (status === "added") {
        newFolders.add(folder);
      }
      touchedFolders.add(folder);
    }
  }

  // Remove new folders from touched folders for editing check
  newFolders.forEach((f) => touchedFolders.delete(f));

  // Check if new folders exist in base
  const actuallyNewFolders = [];
  for (const folder of newFolders) {
    try {
      await octokit.repos.getContent({
        owner,
        repo,
        path: folder,
        ref: baseRef,
      });
      console.log(`Folder ${folder} already exists in base, skipping.`);
    } catch (e) {
      if (e.status === 404) {
        actuallyNewFolders.push(folder);
      } else {
        throw e;
      }
    }
  }

  // Process touched folders (edits to existing folders)
  for (const folder of touchedFolders) {
    const allowlistPath = `allowlist/${folder}.md`;
    try {
      const res = await octokit.repos.getContent({
        owner,
        repo,
        path: allowlistPath,
        ref: baseRef,
      });

      const content = Buffer.from(res.data.content, "base64").toString("utf-8");
      if (!content.includes(`[@${prAuthor}]`)) {
        console.error(
          `❌ User @${prAuthor} not allowed to edit folder ${folder}. Denying PR.`
        );
        process.exit(1);
      }
    } catch (e) {
      if (e.status === 404) {
        console.error(
          `❌ No allowlist found for folder ${folder}. Denying PR.`
        );
        process.exit(1);
      } else {
        throw e;
      }
    }
  }

  // Process allowlist file edits
  for (const filePath of allowlistEdits) {
    const parts = path.basename(filePath).split(".");
    const folder = parts[0];

    try {
      const res = await octokit.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref: baseRef,
      });

      const content = Buffer.from(res.data.content, "base64").toString("utf-8");
      if (!content.includes(`[@${prAuthor}]`)) {
        console.error(
          `❌ User @${prAuthor} not allowed to edit ${filePath}. Denying PR.`
        );
        process.exit(1);
      }
    } catch (e) {
      if (e.status === 404) {
        // New allowlist file is okay if it's for a new folder being created
        if (!actuallyNewFolders.includes(folder)) {
          console.error(
            `❌ New allowlist file ${filePath} not for new folder. Denying PR.`
          );
          process.exit(1);
        }
      } else {
        throw e;
      }
    }
  }

  // For new folders — create allowlist files and add PR author to global
  if (actuallyNewFolders.length > 0) {
    console.log(`✅ New folders created: ${actuallyNewFolders.join(", ")}`);
    actuallyNewFolders.forEach((folder) => {
      const allowlistFile = `allowlist/${folder}.md`;
      const content = `[@${prAuthor}](https://www.github.com/${prAuthor})\n`;
      fs.writeFileSync(allowlistFile, content);
      cp.execSync(`git add ${allowlistFile}`);
    });
  }

  // Add to global allowlist if not present
  const globalFile = "allowlist/global.md";
  let globalContent = fs.readFileSync(globalFile, "utf-8");
  if (!globalContent.includes(`[@${prAuthor}]`)) {
    console.log(`Adding @${prAuthor} to allowlist/global.md`);
    globalContent += `[@${prAuthor}](https://www.github.com/${prAuthor})\n`;
    fs.writeFileSync(globalFile, globalContent);
    cp.execSync(`git add ${globalFile}`);
  }

  console.log("✅ PR passes all checks.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
