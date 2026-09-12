using System;
using System.IO;
using System.Text;
public class Recorder {
  public static int Main(string[] args) {
    Console.InputEncoding = new UTF8Encoding(false);
    Console.OutputEncoding = new UTF8Encoding(false);
    bool conversion = Array.IndexOf(args, "/usr/bin/wslpath") >= 0;
    string input = conversion ? "" : Console.In.ReadToEnd();
    File.AppendAllText(Environment.GetEnvironmentVariable("CM_BRIDGE_RECORD"),
      Convert.ToBase64String(Encoding.UTF8.GetBytes(string.Join("\0", args))) + "\t" +
      Convert.ToBase64String(Encoding.UTF8.GetBytes(input)) + "\n");
    if (conversion) {
      if (Environment.GetEnvironmentVariable("CM_BRIDGE_CONVERSION_FAIL") == "1") return 9;
      string path = args[args.Length - 1];
      Console.WriteLine("/mnt/" + char.ToLowerInvariant(path[0]) + path.Substring(2).Replace('\\', '/'));
      return 0;
    }
    Console.WriteLine("BRIDGE_OK");
    return int.Parse(Environment.GetEnvironmentVariable("CM_BRIDGE_EXIT") ?? "0");
  }
}
