#!/usr/bin/env bash
# Cross-shell PATH persistence cases sourced by install-cli.test.sh.

assert_managed_source() {
  local name="$1"
  local file="$2"
  local source_line="$3"
  if [ -f "$file" ] && grep -qF "$source_line" "$file"; then
    assert "$name" true
  else
    assert "$name" false
  fi
}

assert_single_marker() {
  local name="$1"
  local file="$2"
  local count
  count="$(grep -cF '# >>> atomicmemory >>>' "$file" 2>/dev/null || true)"
  [ "$count" = "1" ] && assert "$name" true || assert "$name" false
}

printf '\nCase: activation makes the installed am win PATH shadowing\n'
shadow_home="${FIXTURE_ROOT}/home-shadow"
shadow_foreign_bin="${BIN_DIR}/shadow-foreign"
shadow_atomic_bin="${BIN_DIR}/shadow-atomic"
mkdir -p "$shadow_home" "$shadow_foreign_bin"
cat >"${shadow_foreign_bin}/am" <<'EOF'
#!/bin/sh
printf 'foreign-am\n'
EOF
chmod +x "${shadow_foreign_bin}/am"
HOME="$shadow_home" SHELL=/bin/bash \
  PATH="${shadow_foreign_bin}:${shadow_atomic_bin}:/usr/bin:/bin" \
  run_install --version 0.2.0 --bin-dir "$shadow_atomic_bin" >/dev/null
shadow_env="${shadow_home}/.atomicmemory/env"
shadow_path="${shadow_foreign_bin}:${shadow_atomic_bin}:/usr/bin:${shadow_atomic_bin}:/bin"
resolved_am="$(PATH="$shadow_path" sh -c '. "$1"; command -v am' sh "$shadow_env")"
[ "$resolved_am" = "${shadow_atomic_bin}/am" ] \
  && assert "activation makes the installed am win" true \
  || assert "activation makes the installed am win" false
activated_path="$(
  PATH="$shadow_path" sh -c '. "$1"; . "$1"; printf '\''%s'\'' "$PATH"' sh "$shadow_env"
)"
expected_path="${shadow_atomic_bin}:${shadow_foreign_bin}:/usr/bin:/bin"
[ "$activated_path" = "$expected_path" ] \
  && assert "repeated activation keeps one leading install directory" true \
  || assert "repeated activation keeps one leading install directory" false

printf '\nCase: bash configures interactive and login shells idempotently\n'
bash_home="${FIXTURE_ROOT}/home-bash"
bash_bin="${BIN_DIR}/shell-bash"
mkdir -p "$bash_home"
: >"$bash_home/.bash_profile"
HOME="$bash_home" ZDOTDIR="$bash_home" SHELL=/bin/bash \
  run_install --version 0.2.0 --bin-dir "$bash_bin" >/dev/null
HOME="$bash_home" ZDOTDIR="$bash_home" SHELL=/bin/bash \
  run_install --version 0.2.0 --bin-dir "$bash_bin" >/dev/null
source_line=". \"${bash_home}/.atomicmemory/env\""
assert_managed_source "bash configures .bashrc" "$bash_home/.bashrc" "$source_line"
assert_managed_source "bash configures active login profile" "$bash_home/.bash_profile" "$source_line"
assert_single_marker "bash .bashrc entry is idempotent" "$bash_home/.bashrc"
assert_single_marker "bash login entry is idempotent" "$bash_home/.bash_profile"

printf '\nCase: zsh honors ZDOTDIR\n'
zsh_home="${FIXTURE_ROOT}/home-zsh"
zsh_dotdir="${zsh_home}/zdot"
mkdir -p "$zsh_dotdir"
HOME="$zsh_home" ZDOTDIR="$zsh_dotdir" SHELL=/bin/zsh \
  run_install --version 0.2.0 --bin-dir "$BIN_DIR/shell-zsh" >/dev/null
assert_managed_source "zsh configures ZDOTDIR .zshrc" "$zsh_dotdir/.zshrc" \
  ". \"${zsh_home}/.atomicmemory/env\""

printf '\nCase: fish uses conf.d and fish activation syntax\n'
fish_home="${FIXTURE_ROOT}/home-fish"
fish_xdg="${fish_home}/xdg"
fish_conf="${fish_xdg}/fish/conf.d/atomicmemory.fish"
mkdir -p "$fish_xdg/fish"
printf 'set -gx EDITOR vim\n# >>> atomicmemory >>>\nsource old-env.fish\n# <<< atomicmemory <<<\n' \
  >"$fish_xdg/fish/config.fish"
HOME="$fish_home" XDG_CONFIG_HOME="$fish_xdg" ZDOTDIR="$fish_home" SHELL=/usr/bin/fish \
  run_install --version 0.2.0 --bin-dir "$BIN_DIR/shell-fish" >/dev/null
assert_managed_source "fish configures a dedicated conf.d file" "$fish_conf" \
  "source \"${fish_home}/.atomicmemory/env.fish\""
[ "$(grep -cF '# >>> atomicmemory >>>' "$fish_xdg/fish/config.fish")" = "0" ] \
  && assert "fish migrates the legacy config.fish entry" true \
  || assert "fish migrates the legacy config.fish entry" false
no_modify_home="${FIXTURE_ROOT}/home-fish-no-modify"
no_modify_xdg="${no_modify_home}/xdg"
output="$(HOME="$no_modify_home" XDG_CONFIG_HOME="$no_modify_xdg" \
  ZDOTDIR="$no_modify_home" SHELL=/usr/bin/fish \
  run_install --version 0.2.0 --bin-dir "$BIN_DIR/fish-no-modify" --no-modify-path)"
case "$output" in
  *"source \"${no_modify_home}/.atomicmemory/env.fish\""*)
    assert "fish no-modify prints fish activation" true ;;
  *) assert "fish no-modify prints fish activation" false ;;
esac
[ ! -e "$no_modify_xdg/fish/conf.d/atomicmemory.fish" ] \
  && assert "fish no-modify leaves startup files unchanged" true \
  || assert "fish no-modify leaves startup files unchanged" false

printf '\nCase: generic POSIX shell configures .profile\n'
posix_home="${FIXTURE_ROOT}/home-posix"
HOME="$posix_home" ZDOTDIR="$posix_home" SHELL=/bin/dash \
  run_install --version 0.2.0 --bin-dir "$BIN_DIR/shell-posix" >/dev/null
assert_managed_source "POSIX shell configures .profile" "$posix_home/.profile" \
  ". \"${posix_home}/.atomicmemory/env\""

printf '\nCase: uninstall removes every managed shell entry\n'
HOME="$bash_home" ZDOTDIR="$bash_home" SHELL=/bin/bash AM_INSTALL_DIR="$bash_bin" \
  sh "$INSTALLER" --uninstall >/dev/null
[ "$(grep -cF '# >>> atomicmemory >>>' "$bash_home/.bashrc" 2>/dev/null || true)" = "0" ] \
  && assert "uninstall cleans bash .bashrc" true || assert "uninstall cleans bash .bashrc" false
HOME="$fish_home" XDG_CONFIG_HOME="$fish_xdg" ZDOTDIR="$fish_home" SHELL=/usr/bin/fish \
  AM_INSTALL_DIR="$BIN_DIR/shell-fish" sh "$INSTALLER" --uninstall >/dev/null
[ ! -e "$fish_conf" ] && assert "uninstall removes fish conf.d entry" true \
  || assert "uninstall removes fish conf.d entry" false
HOME="$posix_home" ZDOTDIR="$posix_home" SHELL=/bin/dash \
  AM_INSTALL_DIR="$BIN_DIR/shell-posix" sh "$INSTALLER" --uninstall >/dev/null
[ "$(grep -cF '# >>> atomicmemory >>>' "$posix_home/.profile" 2>/dev/null || true)" = "0" ] \
  && assert "uninstall cleans POSIX profile" true || assert "uninstall cleans POSIX profile" false
