import { validateDefinition } from "./device-definition.js";

export async function deviceMenu(adapters, { afterProvision = false } = {}) {
  const p = adapters.prompts;
  const cancelled = { stdout: "", cancelled: true };
  if (!p) return cancelled;
  const choose = (message, options, initialValue) =>
    p.select({
      message,
      options: options.map(([value, label]) => ({ value, label })),
      initialValue,
    });
  const command = (...args) =>
    adapters.runCommand(["ca", "profile", ...args], adapters);
  try {
    if (
      afterProvision &&
      (await choose(
        "Set up household devices?",
        [
          ["skip", "Skip for now"],
          ["setup", "Set up now"],
        ],
        "skip",
      )) !== "setup"
    )
      return cancelled;
    const names = JSON.parse((await command("list")).stdout);
    const selected = names.length
      ? await choose(
          "Device setup package",
          [...names.map((n) => [n, n]), ["+", "New package"]],
          names[0],
        )
      : "+";
    const name =
      selected === "+"
        ? await p.ask("Logical package name (lowercase slug)")
        : selected;
    if (selected === "+" && names.includes(name))
      throw new Error("That package already exists. Select it to edit.");
    const saved =
      selected === "+"
        ? {}
        : JSON.parse((await command("inspect", "--name", name)).stdout);
    const target = await choose(
      "Devices",
      [
        ["both", "Apple and Windows"],
        ["apple", "Apple"],
        ["windows", "Windows"],
      ],
      saved.targets?.length === 1 ? saved.targets[0] : "both",
    );
    const targets = target === "both" ? ["apple", "windows"] : [target];
    const appleDns = targets.includes("apple")
      ? await choose(
          "Apple device DNS",
          [
            ["existing", "Use the device's existing DNS"],
            ["encrypted", "Use encrypted DNS on home Wi-Fi"],
          ],
          saved.appleDns ?? "existing",
        )
      : undefined;
    const displayName = await p.ask("Display name", saved.displayName ?? name);
    const description = await p.ask(
      "Description",
      saved.description ?? "Home network device setup",
    );
    const ssids = [];
    let mode, suffix, resolver;
    let addresses = [];
    if (appleDns === "encrypted" || targets.includes("windows")) {
      for (const previous of saved.ssids ?? []) {
        if (
          await p.confirm({
            message: "Keep home Wi-Fi " + previous + "?",
            initialValue: true,
          })
        )
          ssids.push(previous);
      }
      while (
        !ssids.length ||
        (await p.confirm({
          message: "Add another home Wi-Fi name?",
          initialValue: false,
        }))
      )
        ssids.push(await p.ask("Exact home Wi-Fi name"));
      mode = await choose(
        "DNS policy",
        [
          ["private-domain", "Only private domain"],
          ["whole-system", "All system DNS names"],
        ],
        saved.mode ?? "private-domain",
      );
      if (mode === "private-domain")
        suffix = await p.ask("Private DNS suffix", saved.suffix);
      addresses = (
        await p.ask(
          "Resolver IP addresses (comma separated)",
          saved.addresses?.join(", "),
        )
      )
        .split(",")
        .map((ip) => ip.trim());
    }
    if (appleDns === "encrypted")
      resolver = await p.ask("Resolver TLS hostname", saved.resolver);
    const shortcuts = [];
    for (const old of saved.shortcuts ?? [])
      if (
        await p.confirm({
          message: "Keep " + old.name + " (" + old.url + ")?",
          initialValue: true,
        })
      )
        shortcuts.push(old);
    while (
      await p.confirm({ message: "Add a shortcut?", initialValue: false })
    ) {
      const label = await p.ask("Shortcut name"),
        url = await p.ask("Complete web URL");
      const icon = (await p.confirm({
        message: "Use a custom PNG icon?",
        initialValue: false,
      }))
        ? await p.ask("Local PNG file")
        : undefined;
      const opening =
        target === "windows"
          ? "browser"
          : await choose(
              "Opening behavior",
              [
                ["browser", "Default browser"],
                [
                  "ios-fullscreen",
                  "Fullscreen on iPhone/iPad, browser elsewhere",
                ],
              ],
              "browser",
            );
      shortcuts.push({ name: label, url, icon, opening });
    }
    const pkg = validateDefinition({
      name,
      displayName,
      description,
      ssids,
      targets,
      appleDns,
      mode,
      suffix,
      resolver,
      addresses,
      shortcuts,
    });
    const output = await p.ask(
      "Fresh export directory",
      name + "-" + (mode ?? "trust"),
    );
    p.info(
      JSON.stringify(pkg, null, 2) +
        "\nDestination: " +
        output +
        (targets.includes("windows")
          ? "\nWindows uses ordinary port 53 DNS. Its existing local name fallback and VPN policies still apply."
          : "") +
        (mode === "whole-system"
          ? "\nA resolver outage at home may stop ordinary browsing."
          : ""),
    );
    if (
      !(await p.confirm({
        message: "Save these selections?",
        initialValue: false,
      }))
    )
      return cancelled;
    await command(
      "configure",
      "--name",
      name,
      "--display-name",
      displayName,
      "--description",
      description,
      ...(appleDns ? ["--apple-dns", appleDns] : []),
      ...(mode ? ["--mode", mode] : []),
      ...(resolver ? ["--resolver", resolver] : []),
      ...targets.flatMap((t) => ["--target", t]),
      ...ssids.flatMap((s) => ["--ssid", s]),
      ...addresses.flatMap((ip) => ["--address", ip]),
      ...(suffix ? ["--suffix", suffix] : []),
      ...(shortcuts.length
        ? shortcuts.flatMap((s) => ["--shortcut", JSON.stringify(s)])
        : ["--clear-shortcuts"]),
    );
    if (
      appleDns === "encrypted" &&
      (await p.confirm({
        message: "Review Technitium encrypted DNS listener setup?",
        initialValue: false,
      }))
    ) {
      const upgrade = await p.confirm({
        message: "Include an in-place Technitium upgrade in the review?",
        initialValue: false,
      });
      const setup = [
        "resolver-setup",
        "--name",
        name,
        ...(upgrade ? ["--upgrade-technitium"] : []),
      ];
      const review = await command(...setup);
      p.info(review.stdout);
      const token = review.stdout.match(/--approve ([a-f0-9]{64})/);
      if (
        token &&
        (await p.confirm({
          message: upgrade
            ? "Apply the reviewed upgrade and DNS changes?"
            : "Apply the displayed listener change?",
          initialValue: false,
        }))
      )
        p.info((await command(...setup, "--approve", token[1])).stdout);
    }
    if (
      !(await p.confirm({
        message: mode ? "Verify resolver and export now?" : "Export now?",
        initialValue: false,
      }))
    )
      return { stdout: "Device setup selections saved.\n" };
    try {
      return await command("export", "--name", name, "--output", output);
    } catch (error) {
      if (!error.message.startsWith("CA root rotated")) throw error;
      p.warn(error.message);
      if (
        !(await p.confirm({
          message: "Accept the new root fingerprint?",
          initialValue: false,
        }))
      )
        return cancelled;
      return await command(
        "export",
        "--name",
        name,
        "--output",
        output,
        "--accept-root-change",
      );
    }
  } catch (error) {
    if (error.message === "Setup cancelled.") return cancelled;
    if (!afterProvision) throw error;
    p.warn("CA provisioning succeeded. Device setup stopped: " + error.message);
    return cancelled;
  }
}
