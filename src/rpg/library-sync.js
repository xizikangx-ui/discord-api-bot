"use strict";
const C = require("./constants"),
  U = require("./ui"),
  L = require("../web/library"),
  G = require("./gm-service");
function createLibrarySync({
  store,
  needGM,
  client,
  logFailure,
  contentRepository,
}) {
  let repo, timer;
  const jobs = new Set();
  function enabled() {
    return (
      process.env.RPG_SHARED_LIBRARY_ENABLED === "1" &&
      !!process.env.WEB_LIBRARY_KEY &&
      !!store.database
    );
  }
  function repository() {
    C.requireThat(enabled(), "公共库同步尚未启用。");
    if (contentRepository) return contentRepository;
    return (repo ||= require("../web/repository").createRepository(
      store.database.pool,
      require("../web/security").codec(process.env.WEB_LIBRARY_KEY),
      { schema: "web_content" },
    ));
  }
  async function panel(i) {
    needGM(store.snapshot(i.guildId), i.member);
    const entries = await repository().list("entry");
    const f = await store.transact(
      i.guildId,
      "library-preview:" + i.id,
      i.user.id,
      (s) => {
        needGM(s, i.member);
        const preview = L.planSync(s, entries),
          f = {
            id: C.id("f"),
            kind: "publicLibrarySync",
            owner: i.user.id,
            preview,
            resolutions: {},
            expiresAt: C.confirmationDeadline(300000),
          };
        s.forms[f.id] = f;
        return f;
      },
      "公共库同步预览",
      { delivery: false },
    );
    return view(
      f,
      store.select(i.guildId, (s) => s.config.publicLibraryAutoSync !== false),
    );
  }
  function view(f, auto) {
    return U.payload(
      "公共模板库同步",
      "可更新 " +
        f.preview.changes.length +
        " 项；冲突 " +
        f.preview.conflicts.length +
        " 项。\n" +
        f.preview.changes
          .slice(0, 12)
          .map((c) => "＋ " + c.name + " · v" + c.version)
          .join("\n") +
        "\n" +
        f.preview.conflicts
          .slice(0, 12)
          .map((c) => "⚠ " + c.name + "：" + c.reason)
          .join("\n") +
        "\n\n默认保留本地修改；选择覆盖项后须重新确认。已发物品、既有房间及NPC快照保持原状。",
      [
        U.row(
          U.button(
            "library:confirm:" + f.id,
            "确认同步",
            U.D.ButtonStyle.Success,
          ),
          U.button(
            "library:toggle:" + f.id,
            auto ? "关闭每日自动同步" : "开启每日自动同步",
          ),
        ),
        ...(f.preview.conflicts.some((c) => !c.missing?.length)
          ? [
              U.row(
                new U.D.StringSelectMenuBuilder()
                  .setCustomId("rpg:library:resolve:" + f.id)
                  .setPlaceholder("明确选择用公共版覆盖的冲突（最多25项）")
                  .setMinValues(0)
                  .setMaxValues(
                    Math.min(
                      25,
                      f.preview.conflicts.filter((c) => !c.missing?.length)
                        .length,
                    ),
                  )
                  .addOptions(
                    f.preview.conflicts
                      .filter((c) => !c.missing?.length)
                      .slice(0, 25)
                      .map((c) => ({
                        label: c.name || c.id,
                        value: c.id,
                        default: f.resolutions[c.id] === "replace",
                      })),
                  ),
              ),
            ]
          : []),
      ],
    );
  }
  async function component(i) {
    needGM(store.snapshot(i.guildId), i.member);
    const [, , action, id] = i.customId.split(":"),
      entries = await repository().list("entry");
    const result = await store.transact(
      i.guildId,
      "library-operation:" + i.id,
      i.user.id,
      (s) => {
        needGM(s, i.member);
        const f = s.forms[id];
        C.requireThat(
          f?.kind === "publicLibrarySync" &&
            f.owner === i.user.id &&
            f.expiresAt > Date.now() &&
            !f.done,
          "同步预览已失效。",
        );
        if (action === "confirm") {
          const r = L.applySync(s, entries, f.preview, {
            resolutions: f.resolutions,
          });
          f.done = true;
          return r;
        }
        if (action === "resolve") {
          f.resolutions = Object.fromEntries(
            i.values.map((v) => [v, "replace"]),
          );
          return f;
        }
        C.requireThat(action === "toggle", "同步操作无效。");
        s.config.publicLibraryAutoSync =
          s.config.publicLibraryAutoSync === false;
        return f;
      },
      "公共模板库同步",
      { delivery: false },
    );
    return action === "confirm"
      ? U.payload(
          "同步已保存",
          "更新 " +
            result.updated +
            " 项；保留 " +
            result.conflicts.length +
            " 项冲突。",
        )
      : view(
          result,
          store.select(
            i.guildId,
            (s) => s.config.publicLibraryAutoSync !== false,
          ),
        );
  }
  async function tick() {
    if (!enabled()) return;
    const entries = await repository().list("entry");
    for (const guild of store.guilds()) {
      if (
        store.frozen(guild) ||
        store.select(
          guild,
          (s) =>
            s.config.publicLibraryAutoSync === false ||
            Date.now() - (s.librarySync?.lastSyncAt || 0) < 86400000,
        )
      )
        continue;
      await store.transact(
        guild,
        "public-library-auto:" + Math.floor(Date.now() / 86400000),
        client.user.id,
        (s) => L.applySync(s, entries, L.planSync(s, entries)),
        "公共库每日同步",
        { delivery: false },
      );
    }
  }
  function start() {
    if (!enabled()) return;
    const run = () => {
      const p = tick().catch((e) =>
        logFailure("公共模板库同步失败，原内容保留。", e),
      );
      jobs.add(p);
      p.finally(() => jobs.delete(p));
    };
    run();
    timer = setInterval(run, 3600000);
    timer.unref();
  }
  return {
    panel,
    component,
    start,
    stop() {
      clearInterval(timer);
    },
    drain: () => Promise.allSettled([...jobs]),
  };
}
module.exports = { createLibrarySync };
