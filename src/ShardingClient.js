// Modules
const fetch = require("node-fetch");

/**
 * @class ShardingClient
 */
class ShardingClient {
    /**
     * @typedef {Object} ShardingClientOptions
     * @property {string} key - your statcord key prefix by "statcord.com-""
     * @property {*} manager - your discord.js shardingmanager
     * @property {boolean} [postCpuStatistics=true] - Whether you want to post CPU usage
     * @property {boolean} [postMemStatistics=true] - Whether you want to post mem usage
     */

    /**
     * @typedef {import("discord.js").ShardingManager} ShardingManager
     */

    /**
     * Sharding client
     * @param {ShardingClientOptions} options
     */
    constructor(options) {
        const { key, manager } = options;
        let { postCpuStatistics, postMemStatistics } = options;

        // Check for discord.js
        try {
            this.discord = require("discord.js");
        } catch(e) {
            throw new Error("statcord.js needs discord.js to function");
        }

        // Key error handling
        if (!key) throw new Error('"key" is missing or undefined');
        if (typeof key !== "string") throw new TypeError('"key" is not typeof string');
        if (!key.startsWith("statcord.com-")) throw new Error('"key" is not prefixed by "statcord.com-", please follow the key format');
        // Manager error handling
        if (!manager) throw new Error('"manager" is missing or undefined');
        if (!(manager instanceof this.discord.ShardingManager)) throw new TypeError('"manager" is not a discord.js sharding manager');
        // Post arg error checking
        if (postCpuStatistics == null || postCpuStatistics == undefined) postCpuStatistics = true;
        if (typeof postCpuStatistics !== "boolean") throw new TypeError('"postCpuStatistics" is not of type boolean');
        if (postMemStatistics == null || postMemStatistics == undefined) postMemStatistics = true;
        if (typeof postMemStatistics !== "boolean") throw new TypeError('"postMemStatistics" is not of type boolean');

        // API config
        this.baseApiUrl = "https://beta.statcord.com/logan/stats"; //TODO update before full release
        this.key = key;
        this.manager = manager;

        // General config
        this.v11 = this.discord.version <= "12.0.0";
        this.v12 = this.discord.version >= "12.0.0";
        this.activeUsers = [];
        this.commandsRun = 0;
        this.popularCommands = [];

        // Opt ins
        this.postCpuStatistics = postCpuStatistics;
        this.postMemStatistics = postMemStatistics;
        
        /**
         * Create custom fields map
         * @type {Map<1 | 2, (manager: ShardingManager) => Promise<string>> }
         * @private
         */
        this.customFields = new Map();

        // Check if all shards have been spawned
        this.manager.on("shardCreate", (shard) => {
            // Get current shard
            let currShard = this.manager.shards.get(shard.id);

            // If this is the last shard, wait until it is ready
            if (shard.id + 1 == this.manager.totalShards) {
                // When ready start auto post
                currShard.once("ready", () => {
                    setTimeout(() => {
                        console.log("Starting autopost");

                        setInterval(async () => {
                            await this.post();
                        }, 60000);
                    }, 200);
                });
            }

            // Start message listener
            currShard.on("message", async (message) => {
                // If there is no message or it isn't a string (ignore broadcastEvals)
                if (!message || typeof message !== "string") return;

                // Check if they are statcord messages
                if (!message.startsWith("ssc")) return;
                let args = message.split("|=-ssc-=|"); // get the args

                if (args[0] == "sscpc") { // PostCommand message
                    await this.postCommand(args[1], args[2]);
                } else if (args[0] == "sscp") { // Post message
                        let post = await this.post();
                        if (post) console.error(new Error(post));
                    }
            });
        });
    }

    /**
     * Manual posting
     * @private
     * @returns {Promise<boolean | Error>} returns false if there was no error, returns an error if there was.
     */
    async post() {
        // counts
        let guild_count = 0;
        let user_count = 0;

        // V12 code
        if (this.v12) {
            guild_count = await getGuildCountV12(this.manager);
            user_count = await getUserCountV12(this.manager);
        } else if (this.v11) { // V11 code
            guild_count = await getGuildCountV11(this.manager);
            user_count = await getUserCountV11(this.manager);
        }

        // Get and sort popular commands
        let popular = [];

        let sortedPopular = this.popularCommands.sort((a, b) => a.count - b.count).reverse();

        for (let i = 0; i < sortedPopular.length; i++) {
            popular.push({
                name: sortedPopular[i].name,
                count: `${sortedPopular[i].count}`
            });
        }

        // Limit popular to the 5 most popular
        if (popular.length > 5) popular.length = 5;

        // Get system information
        let memactive = 0;
        let memload = 0;
        let cpuload = 0;
        let cputemp = 0;

        if (this.postMemStatistics) {
            const mem = await si.mem();

            memactive = Math.round(mem.active / 1000000);; // TODO convert to megabytes
            memload = Math.fround(mem.active / mem.total * 100);
        }

        if (this.postCpuStatistics) {
            const platform = require("os").platform();

            if (platform !== "freebsd" && platform !== "netbsd" && platform !== "openbsd") {
                const load = await si.currentLoad();

                cpuload = Math.round(load.currentload);
            }

            // TODO issues with temperature readouts in systeminformation - temp cannot be done just yet
            // TODO discovered fix, waitinf for approval
        }

        // Get client id
        let id = (await this.manager.broadcastEval("this.user.id"))[0];

        // Post data
        let requestBody = {
            id, // Client id
            key: this.key, // API key
            servers: guild_count.toString(), // Server count
            users: user_count.toString(), // User count
            active: this.activeUsers.length.toString(), // Users that have run commands since the last post
            commands: this.commandsRun.toString(), // The how many commands have been run total
            popular, // the top 5 commands run and how many times they have been run
            memactive,
            memload,
            cpuload,
            cputemp
        }

        // Get custom field one value
        if (this.customFields.get(1)) {
            requestBody.custom1 = await this.customFields.get(1)(this.manager);
        }

        // Get custom field two value
        if (this.customFields.get(2)) {
            requestBody.custom1 = await this.customFields.get(2)(this.manager);
        }        

        // Reset stats
        this.activeUsers = [];
        this.commandsRun = 0;
        this.popularCommands = [];

        // Create post request
        let response = await fetch(this.baseApiUrl, {
            method: "post",
            body: JSON.stringify(requestBody),
            headers: {
                "Content-Type": "application/json"
            }
        });

        // Statcord server side errors
        if (response.status >= 500) return new Error(`Statcord server error, statuscode: ${response.status}`);

        // Get body as JSON
        let responseData = await response.json();

        // Check response for errors
        if (response.status == 200) {
            // Success
            if (!responseData.error) return Promise.resolve(false);
        } else if (response.status == 400) {
            // Bad request
            if (responseData.error) return Promise.resolve(new Error(responseData.message));
        } else if (response.status == 429) {
            // Rate limit hit
            if (responseData.error) return Promise.resolve(new Error(responseData.message));
        } else {
            // Other
            return Promise.resolve(new Error("An unkown error has occurred"));
        }
    }

    /**
     * Post stats about a command
     * @private
     * @param {string} command_name - The name of the command that was run
     * @param {string} author_id - The id of the user that ran the command
     */
    async postCommand(command_name, author_id) {
        // Command name error checking
        if (!command_name) throw new Error('"command_name" is missing or undefined');
        if (typeof command_name !== "string") throw new TypeError('"command_name" is not typeof string');
        // Author id error checking
        if (!author_id) throw new Error('"author_id" is missing or undefined');
        if (typeof author_id !== "string") throw new TypeError('"author_id" is not typeof string');

        // Add the user to the active users list if they aren't already there
        if (!this.activeUsers.includes(author_id)) this.activeUsers.push(author_id);

        // Check if the popular commands has this command
        if (!this.popularCommands.some(command => command.name == command_name)) {
            // If it doesn't exist add to the array
            this.popularCommands.push({
                name: command_name,
                count: 1
            });
        } else {
            // If it does exist increment the count of the command
            let commandIndex = this.popularCommands.findIndex(command => command.name == command_name);
            // Increment the command count
            this.popularCommands[commandIndex].count++;
        }

        // Increment the commandsRun variable
        this.commandsRun++;
    }

    /**
     * Register the function to get the values for posting
     * @param {1 | 2} customFieldNumber - Whether the handler is for customField1 or customField2 
     * @param {(manager: ShardingManager) => Promise<string>} handler - Your function to get
     * @returns {Error | null}
     */
    async registerCustomFieldHandler(customFieldNumber, handler) {
        if (this.customFields.get(customFieldNumber)) return new Error("Handler already exists");

        this.customFields.set(customFieldNumber, handler);
    }
}

// V12 sharding gets 
async function getGuildCountV12(manager) {
    return (await manager.fetchClientValues("guilds.cache.size")).reduce((prev, current) => prev + current, 0);
}

async function getUserCountV12(manager) {
    const memberNum = await manager.broadcastEval('this.guilds.cache.reduce((prev, guild) => prev + guild.memberCount, 0)');
    return memberNum.reduce((prev, memberCount) => prev + memberCount, 0);
}
// end

// v11 sharding gets
async function getGuildCountV11(manager) {
    return (await manager.fetchClientValues("guilds.size")).reduce((prev, current) => prev + current, 0);
}

async function getUserCountV11(manager) {
    return (await manager.fetchClientValues("users.size")).reduce((prev, current) => prev + current, 0);
}
//end

module.exports = ShardingClient;

const ShardingUtil = require("./util/shardUtil");

module.exports.postCommand = ShardingUtil.postCommand;
module.exports.post = ShardingUtil.post;
