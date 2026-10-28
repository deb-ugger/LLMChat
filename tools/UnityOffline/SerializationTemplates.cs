using AssetsTools.NET;
using AssetsTools.NET.Extra;
using Mono.Cecil;

namespace LLMChat.UnityOffline;

// Unity does not serialize multidimensional arrays. The Cecil template generator
// currently treats them as their element type, shifting all following fields.
public sealed class SerializationTemplates : IMonoBehaviourTemplateGenerator
{
    readonly string directory;
    readonly MonoCecilTempGenerator generator;
    readonly DefaultAssemblyResolver resolver = new();

    public SerializationTemplates(string directory)
    {
        this.directory = directory;
        generator = new(directory);
        resolver.AddSearchDirectory(directory);
    }

    public AssetTypeTemplateField GetTemplateField(AssetTypeTemplateField baseField, string assemblyName, string nameSpace, string className, UnityVersion version)
    {
        var name = assemblyName.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) ? assemblyName : assemblyName + ".dll";
        var path = Path.Combine(directory, name);
        if (!generator.loadedAssemblies.ContainsKey(name) && File.Exists(path)) {
            var assembly = AssemblyDefinition.ReadAssembly(path, new ReaderParameters { AssemblyResolver = resolver });
            generator.loadedAssemblies[name] = assembly;
            foreach (var type in assembly.MainModule.GetTypes())
                foreach (var field in type.Fields)
                    if (field.FieldType is ArrayType { IsVector: false })
                        field.Attributes |= FieldAttributes.NotSerialized;
        }
        return generator.GetTemplateField(baseField, name, nameSpace, className, version);
    }

    public void Dispose() { generator.Dispose(); resolver.Dispose(); }
}
