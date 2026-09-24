param([Parameter(Mandatory=$true)][string]$Executable, [Parameter(Mandatory=$true)][string]$Icon)
$ErrorActionPreference = 'Stop'
# Only the freshly copied portable executable is modified by the packager.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ConvokeIcon {
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr BeginUpdateResource(string file, bool delete);
  [DllImport("kernel32", SetLastError=true)] static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
  [DllImport("kernel32", SetLastError=true)] static extern bool EndUpdateResource(IntPtr update, bool discard);
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);
  [DllImport("kernel32")] static extern bool FreeLibrary(IntPtr module);
  delegate bool NameCallback(IntPtr module, IntPtr type, IntPtr name, IntPtr parameter);
  delegate bool LanguageCallback(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr parameter);
  [DllImport("kernel32", SetLastError=true)] static extern bool EnumResourceNames(IntPtr module, IntPtr type, NameCallback callback, IntPtr parameter);
  [DllImport("kernel32", SetLastError=true)] static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, LanguageCallback callback, IntPtr parameter);
  [DllImport("kernel32", SetLastError=true)] static extern IntPtr FindResourceEx(IntPtr module, IntPtr type, IntPtr name, ushort language);
  [DllImport("kernel32", SetLastError=true)] static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
  [DllImport("kernel32")] static extern IntPtr LockResource(IntPtr resource);
  [DllImport("kernel32")] static extern uint SizeofResource(IntPtr module, IntPtr resource);
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static byte[] Read(IntPtr module, int type, int id, ushort language) {
    IntPtr resource = FindResourceEx(module, (IntPtr)type, (IntPtr)id, language); Check(resource != IntPtr.Zero);
    uint size = SizeofResource(module, resource); byte[] result = new byte[size];
    IntPtr data = LockResource(LoadResource(module, resource)); Check(data != IntPtr.Zero);
    Marshal.Copy(data, result, 0, result.Length); return result;
  }
  public static void Apply(string file, string icon) {
    byte[] bytes = File.ReadAllBytes(icon); var images = new List<byte[]>(); byte[] group;
    using (var reader = new BinaryReader(new MemoryStream(bytes))) {
      if (reader.ReadUInt16() != 0 || reader.ReadUInt16() != 1) throw new InvalidDataException("Expected ICO image");
      ushort count = reader.ReadUInt16(); if (count == 0 || count > 32 || bytes.Length < 6 + count * 16) throw new InvalidDataException("Invalid ICO directory");
      using (var stream = new MemoryStream()) using (var writer = new BinaryWriter(stream)) {
        writer.Write((ushort)0); writer.Write((ushort)1); writer.Write(count);
        for (int i = 0; i < count; i++) {
          byte[] dimensions = reader.ReadBytes(8); uint size = reader.ReadUInt32(), offset = reader.ReadUInt32();
          if (size == 0 || offset < 6 + count * 16 || (ulong)offset + size > (ulong)bytes.Length) throw new InvalidDataException("Invalid ICO image range");
          writer.Write(dimensions); writer.Write(size); writer.Write((ushort)(40001 + i));
          byte[] image = new byte[size]; Array.Copy(bytes, offset, image, 0, size); images.Add(image);
        }
        writer.Flush(); group = stream.ToArray();
      }
    }
    var targets = new List<Tuple<int,ushort>>();
    IntPtr library = LoadLibraryEx(file, IntPtr.Zero, 2); Check(library != IntPtr.Zero);
    try {
      NameCallback names = delegate(IntPtr m, IntPtr t, IntPtr n, IntPtr p) {
        long id = n.ToInt64(); if (id < 1 || id > 65535) throw new InvalidDataException("Named icon groups are unsupported");
        LanguageCallback languages = delegate(IntPtr lm, IntPtr lt, IntPtr ln, ushort lang, IntPtr lp) { targets.Add(Tuple.Create((int)id,lang)); return true; };
        Check(EnumResourceLanguages(m, t, n, languages, IntPtr.Zero)); return true;
      };
      Check(EnumResourceNames(library, (IntPtr)14, names, IntPtr.Zero));
    } finally { FreeLibrary(library); }
    if (targets.Count == 0) throw new InvalidDataException("Executable has no icon group");
    IntPtr update = BeginUpdateResource(file, false); Check(update != IntPtr.Zero);
    try {
      foreach (ushort language in targets.Select(x => x.Item2).Distinct())
        for (int i = 0; i < images.Count; i++) Check(UpdateResource(update, (IntPtr)3, (IntPtr)(40001+i), language, images[i], (uint)images[i].Length));
      foreach (var target in targets) Check(UpdateResource(update, (IntPtr)14, (IntPtr)target.Item1, target.Item2, group, (uint)group.Length));
      bool committed = EndUpdateResource(update, false); update = IntPtr.Zero; Check(committed);
    } finally { if (update != IntPtr.Zero) EndUpdateResource(update, true); }
    library = LoadLibraryEx(file, IntPtr.Zero, 2); Check(library != IntPtr.Zero);
    try {
      foreach (var target in targets) {
        if (!Read(library,14,target.Item1,target.Item2).SequenceEqual(group)) throw new InvalidDataException("Icon group verification failed");
        for (int i=0;i<images.Count;i++) if (!Read(library,3,40001+i,target.Item2).SequenceEqual(images[i])) throw new InvalidDataException("Icon resource verification failed");
      }
    } finally { FreeLibrary(library); }
  }
}
'@
[ConvokeIcon]::Apply((Resolve-Path -LiteralPath $Executable).Path, (Resolve-Path -LiteralPath $Icon).Path)
Write-Output 'CONVOKE_ICON_VERIFIED'
