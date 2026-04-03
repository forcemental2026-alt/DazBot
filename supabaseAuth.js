const { BufferJSON, initAuthCreds, proto } = require('@whiskeysockets/baileys');

module.exports = async (supabase, tableName = 'whatsapp_auth') => {
    // Write data to Supabase
    const writeData = async (data, id) => {
        try {
            const jsonStr = JSON.stringify(data, BufferJSON.replacer);
            const parsedData = JSON.parse(jsonStr);
            
            const { error } = await supabase
                .from(tableName)
                .upsert({ id, data: parsedData }, { onConflict: 'id' });
            
            if (error) console.error('[Supabase Auth] Erreur de sauvegarde', id, error.message);
        } catch (e) {
            console.error('[Supabase Auth] Except', e);
        }
    };

    // Read data from Supabase
    const readData = async (id) => {
        try {
            const { data, error } = await supabase
                .from(tableName)
                .select('data')
                .eq('id', id)
                .maybeSingle();

            if (error || !data) return null;
            
            const jsonStr = JSON.stringify(data.data);
            return JSON.parse(jsonStr, BufferJSON.reviver);
        } catch (error) {
            return null;
        }
    };

    // Remove data from Supabase
    const removeData = async (id) => {
        try {
            await supabase.from(tableName).delete().eq('id', id);
        } catch (error) {
            console.error('[Supabase Auth] Delete Error', error);
        }
    };

    let creds = await readData('creds');
    if (!creds) {
        creds = initAuthCreds();
        await writeData(creds, 'creds');
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    // Paralléliser toutes les écritures au lieu de les faire une par une
                    // Evite les timeouts de connexion dus aux sauvegardes trop lentes
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(value, key));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => {
            return writeData(creds, 'creds');
        }
    };
};
