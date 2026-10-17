import { describe, expect, it } from "vitest";
import {
  authFromTags,
  indexKeys,
  isAuthTag,
  parseAuthTag,
} from "../../src/backend/auth-tags.js";

const config = { authTagPrefix: "tauth", credentialId: 7 };
const keys = indexKeys([
  { id: 11, name: "Deploy Key" },
  { id: 12, name: "root" },
]);
const tag = (name: string, slug = name.replace(/:/g, "-")) => ({ name, slug });

describe("login tags", () => {
  it("reads the name form and the slug form", () => {
    expect(parseAuthTag(tag("tauth:sshkey:Deploy Key"), "tauth")).toEqual({
      label: "tauth:sshkey:Deploy Key",
      method: "sshkey",
      argument: "Deploy Key",
    });
    expect(
      parseAuthTag(
        { name: "SSH key login", slug: "tauth-sshkey-deploy-key" },
        "tauth",
      ),
    ).toEqual({
      label: "SSH key login",
      method: "sshkey",
      argument: "deploy-key",
    });
    expect(isAuthTag(tag("linux"), "tauth")).toBe(false);
    expect(isAuthTag(tag("TAUTH:userpass"), "tauth")).toBe(true);
  });

  it("maps each method to a Termix auth type", () => {
    expect(authFromTags([tag("tauth:userpass")], config, keys)).toEqual({
      auth: { authType: "password", credentialId: null },
    });
    expect(authFromTags([tag("tauth:none")], config, keys)).toEqual({
      auth: { authType: "none", credentialId: null },
    });
    expect(authFromTags([tag("tauth:sshkey")], config, keys)).toEqual({
      auth: { authType: "credential", credentialId: 7 },
    });
  });

  it("finds a named key by name or slug", () => {
    expect(
      authFromTags([tag("tauth:sshkey:deploy key")], config, keys).auth,
    ).toEqual({ authType: "credential", credentialId: 11 });
    expect(
      authFromTags(
        [{ name: "x", slug: "tauth-sshkey-deploy-key" }],
        config,
        keys,
      ).auth,
    ).toEqual({ authType: "credential", credentialId: 11 });
  });

  it("uses no login tag as no choice", () => {
    expect(authFromTags([tag("linux")], config, keys)).toEqual({ auth: null });
  });

  it("reports tags it can't use", () => {
    expect(authFromTags([tag("tauth:telnet")], config, keys).error).toBe(
      "unknown login tag tauth:telnet",
    );
    expect(
      authFromTags([tag("tauth:sshkey:missing")], config, keys).error,
    ).toContain('no SSH key named "missing"');
    expect(
      authFromTags(
        [tag("tauth:sshkey")],
        { ...config, credentialId: null },
        keys,
      ).error,
    ).toContain("needs an SSH key");
    expect(
      authFromTags([tag("tauth:sshkey"), tag("tauth:userpass")], config, keys)
        .error,
    ).toBe("login tags disagree");
  });

  it("treats the same method twice as one", () => {
    expect(
      authFromTags(
        [tag("tauth:userpass"), { name: "x", slug: "tauth-userpass" }],
        config,
        keys,
      ).auth,
    ).toEqual({ authType: "password", credentialId: null });
  });

  it("follows a custom prefix", () => {
    expect(
      authFromTags(
        [tag("login:userpass")],
        { ...config, authTagPrefix: "login" },
        keys,
      ).auth,
    ).toEqual({ authType: "password", credentialId: null });
  });
});
