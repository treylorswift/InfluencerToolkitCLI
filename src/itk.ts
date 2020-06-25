var usage =
`\nitk ("Influencer Toolkit") automates sending of direct messages to your Twitter followers.

Usage:

  node itk.js messaging_campaign_filename.json

  node itk.js { messaging campaign json specified directly on command line }

  node itk.js -rebuildFollowers <optional username>

app_auth.json must be present in the working directory and contain Twitter
app authorization keys as follows:

{
    consumer_key:string,
    consumer_secret:string
}

user_auth.json must be present in the working directory and contain Twitter
user authorization keys as follows:

{
    access_token_key:string,
    access_token_secret:string,
}

The first time you run itk, it will first retreive all of your followers
and their follower counts in order to rank them by influence. Api rate
limits mean this may take awhile if you have many followers (around 300k
followers per hour due to api rate limits).

Your followers are cached and won't be retreived again unless you run with the
-rebuildFollowers option. If you abort the caching of followers, you can resume
by just re-running itk, but you should do so as quickly as possible since the
longer you wait the more likely circumstances could arise that make resuming not
possible (ie, the follower list itself changes substantially).

The messaging campaign json is as follows:

{
    message:string - message content - this is the only required field,
                     all other fields below are optional
                 
    count:number - limits sending to <number> followers. if not specified,
                   will send to all followers who have not already been
                   contacted for this campaign, subject to Twitters 1000 msg
                   per 24-hour-period limitations

    campaign_id:string - the identifier for this messaging campaign.
                         used to ensure each follower only receives
                         a single message for this campaign. if you
                         send to only a few followers at first, you can
                         change the message content for the campaign
                         for the remaining followers, and it will not
                         re-send to followers who have already been 
                         contacted in this campaign. if you don't specify
                         a campaign id, one will be generated by hashing
                         the message content.

    filter:
    {
        tags:Array<string> - will only send to a follower if their Twitter bio
                             contains at least 1 word that matches at least 1
                             of the specified tags. Matching is not case-sensitive.
    }

    sort:string - "influence" orders recipients by their follower count,
                  "recent" orders them by how recently they followed you.
                  If not specified, default is "influence".

    dryRun:boolean - set to true to prevent messages from being sent or logged, useful
                     during testing

    scheduling:string - "burst" will send without delay as many msgs as possible
                        (sending all 1000 msgs allowed per day at once)
                        "spread" will spread sends out over a 24 hour period
                        (one message every 1 minute and 26 seconds, approximately)
                        default is "burst"
}
            
Examples:

btcCampaign.json:
  {
      "campaign_id": "btc001",
      "message": "Buy Bitcoin!",
      "sort": "influence",
      "filter": {
          "tags": [
              "bitcoin"
          ]
      },
      "count": 10
  }

  node itk.js btcCampaign.json

  This sends "Buy Bitcoin!" to the top 10 most influential people following you.
  Run the same command a second time to send the same message to the next 10 most
  influential people following you.

node itk.js -rebuildFollowers

  This will retreive all of your followers and save them to
  your_twitter_handle.followers.json, overwriting any previous cache saved there.
  If a previous follower cache operation was aborted in progress, it will attempt to
  resume.
`;

if (process.argv.length<=2)
{
    console.log(usage);
    process.exit(-1);
}

import * as fs from 'fs';
import * as TwitterAuth from './TwitterAuth'
import {TwitterUser} from './TwitterUser'
import {MessagingCampaign, MessagingCampaignManager} from './MessagingCampaign'
import {TwitterFollowerCacheSQL, FollowerCacheStatusEnum} from './TwitterFollowerDB'

async function main()
{
    //app_auth.json should define the following:
    //  {consumer_key:string, consumer_secret:string}
    let app_auth = TwitterAuth.LoadAppAuth('./app_auth.json')

    //user_auth.json should define the following:
    //  {access_token_key:string, access_token_secret:string};
    let user_auth = TwitterAuth.LoadUserAuth('./user_auth.json');

    //auth files have loaded successfully
    //setup twitter user
    var user = new TwitterUser();
    var initOk = await user.Init(app_auth, user_auth);
    if (initOk!==true)
    {
        console.log("TwitterUser.Init() failed, can't continue");
        return;
    }

    //parse command line

    //only one option to check for ..-rebuildFollowers
    if (process.argv[2]==='-rebuildFollowers')
    {
        let screen_name = user.GetScreenName();

        //the argument after -refreshFollowers can override whose followers are retreived
        if (typeof(process.argv[3])==='string')
            screen_name = process.argv[3];

        let followerCache = new TwitterFollowerCacheSQL();
        let cacheOK = await followerCache.Init(this.twitterApi, screen_name);
        if (cacheOK)
        {
            let buildOK = await followerCache.Build();
            if (buildOK)
                console.log(`Follower cache for ${screen_name} rebuilt`);
            else
                console.log(`Follower cache for ${screen_name} failed`);
        }
        else
        {
            console.log(`Unable to init follower cache for ${screen_name}`);
        }
        return;
    }

    //if not rebuilding followers, command line contains json, or the name of a json file
    let json:any = {}

    try
    {
        if (process.argv[2].startsWith('{'))
        {
            //assume there is json specified on the command line
            let json_string = process.argv.slice(2).join(' ');
            json = JSON.parse(json_string);
            console.log(`Messaging campaign JSON parsed from command line successfully`);
        }
        else
        {
            //assume they named a .json file on the command line
            json = JSON.parse(fs.readFileSync(process.argv[2],'utf-8'));
            console.log(`Messaging campaign JSON parsed from ${process.argv[2]} successfully`);
        }
    }
    catch (err)
    {
        console.log("Error parsing Messaging campaign json:");
        console.error(err);
        return;
    }

    var campaign = MessagingCampaign.fromJSON(json);
    if (campaign)
    {
        //make sure follower cache is built
        let followerCache = user.GetFollowerCache();
        let status = followerCache.GetStatus();
        if (status.status===FollowerCacheStatusEnum.None)
        {
            console.log(`Downloading followers for ${user.GetScreenName()}`);
            let buildOK = await user.GetFollowerCache().Build();
            if (!buildOK)
            {
                console.log(`Follower download for ${user.GetScreenName()} failed, can't continue`);
                return;
            }
        }
        else
        if (status.status===FollowerCacheStatusEnum.Incomplete)
        {
            console.log(`Resuming follower download for ${user.GetScreenName()}`);
            let buildOK = await user.GetFollowerCache().Build();
            if (!buildOK)
            {
                console.log(`Follower download for ${user.GetScreenName()} failed, can't continue`);
                return;
            }
        }

        var campaignManager = new MessagingCampaignManager(user,campaign);
        await campaignManager.Run();
        console.log('Message campaign finished.');
    }
}

main();