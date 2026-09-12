// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"reflect"
	"strconv"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestGetStarterLayoutIsOneFocusedTerminal(t *testing.T) {
	layout := GetStarterLayout()
	if len(layout) != 1 {
		t.Fatalf("starter layout length = %d, want 1", len(layout))
	}

	entry := layout[0]
	if !reflect.DeepEqual(entry.IndexArr, []int{0}) {
		t.Errorf("starter layout index = %v, want [0]", entry.IndexArr)
	}
	if !entry.Focused {
		t.Error("starter layout entry is not focused")
	}
	if entry.BlockDef == nil {
		t.Fatal("starter layout block definition is nil")
	}
	if got := entry.BlockDef.Meta[waveobj.MetaKey_View]; got != "term" {
		t.Errorf("starter layout view = %q, want %q", got, "term")
	}
	if got := entry.BlockDef.Meta[waveobj.MetaKey_Controller]; got != "shell" {
		t.Errorf("starter layout controller = %q, want %q", got, "shell")
	}
}

func TestEnsureInitialDataCreatesWBTStarterWorkspace(t *testing.T) {
	name, icon, color := ensureInitialDataStarterWorkspaceArgs(t)
	if name != "Windows Block Terminal" {
		t.Errorf("starter workspace name = %q, want %q", name, "Windows Block Terminal")
	}
	if icon != "square-terminal" {
		t.Errorf("starter workspace icon = %q, want %q", icon, "square-terminal")
	}
	if color != "#58C142" {
		t.Errorf("starter workspace color = %q, want %q", color, "#58C142")
	}
	if got := WorkspaceIcons[0]; got != "square-terminal" {
		t.Errorf("default workspace icon = %q, want %q", got, "square-terminal")
	}
}

func ensureInitialDataStarterWorkspaceArgs(t *testing.T) (string, string, string) {
	t.Helper()
	source, err := os.ReadFile("wcore.go")
	if err != nil {
		t.Fatalf("read wcore.go: %v", err)
	}
	file, err := parser.ParseFile(token.NewFileSet(), "wcore.go", source, 0)
	if err != nil {
		t.Fatalf("parse wcore.go: %v", err)
	}
	var args []ast.Expr
	ast.Inspect(file, func(node ast.Node) bool {
		fn, ok := node.(*ast.FuncDecl)
		if !ok || fn.Name.Name != "EnsureInitialData" {
			return true
		}
		ast.Inspect(fn.Body, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			ident, ok := call.Fun.(*ast.Ident)
			if ok && ident.Name == "CreateWorkspace" {
				args = call.Args
				return false
			}
			return true
		})
		return false
	})
	if len(args) != 6 {
		t.Fatalf("EnsureInitialData CreateWorkspace argument count = %d, want 6", len(args))
	}
	values := make([]string, 3)
	for i, arg := range args[1:4] {
		literal, ok := arg.(*ast.BasicLit)
		if !ok || literal.Kind != token.STRING {
			t.Fatalf("EnsureInitialData CreateWorkspace argument %d is not a string literal", i+1)
		}
		value, err := strconv.Unquote(literal.Value)
		if err != nil {
			t.Fatalf("unquote CreateWorkspace argument %d: %v", i+1, err)
		}
		values[i] = value
	}
	return values[0], values[1], values[2]
}
