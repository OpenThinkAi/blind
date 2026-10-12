// A small built-in English word list: the profile's dictionaryRatio and the engine's dictionary-word
// rules. It lives in the engine, which imports nothing from src/profile; the profiler imports it. Built in, not read from
// /usr/share/dict, so the ratio is the same on every machine. It only needs to separate prose and
// vocabulary ("open", "pending", "server") from names and codes; it is not a spell checker.
// Written for blind: common function words, everyday nouns, verbs and adjectives, business and IT
// vocabulary, months and weekdays.

const WORDS = `
a about above after again against all almost also always am among an and another any anyone
anything are around as at away back be because been before being below between both but by
can cannot could did do does doing done down during each either else enough even ever every
few for from further had has have having he her here hers herself him himself his how however
i if in into is it its itself just least less let like many may me might more most much must
my myself near neither never no nor not now of off often on once one only or other others our
ours ourselves out over own per perhaps please quite rather same several shall she should
since so some still such than that the their theirs them themselves then there these they this
those though through thus to together too toward under until up upon us very via was we well
were what whatever when where whether which while who whom whose why will with within without
would yet you your yours yourself

zero two three four five six seven eight nine ten eleven twelve hundred thousand million first
second third last next previous half double single

january february march april may june july august september october november december monday
tuesday wednesday thursday friday saturday sunday today tomorrow yesterday day days week weeks
month months year years hour hours minute minutes time date dates morning afternoon evening
night daily weekly monthly yearly annual quarter quarterly

account accounts action actions active activity address admin administrator agenda agreement
alert amount analysis answer application applications approval approved archive area asset
assets assigned audit available backup balance batch begin billing block board body branch
budget bug build business call cancel cancelled capacity case category change changes channel
charge check checked city claim class client clients close closed code comment comments
company complete completed configuration confirm confirmed contact contract cost count country
create created credit current customer customers data database deadline default delete deleted
delivery department description design detail details device devices disabled discount domain
draft due email employee employees enabled end entry environment error errors estimate event
events expense expired export failed failure feature field file files filter final finance
fixed follow form group guest high history home host id image import inactive incident
information input install installed internal invoice issue issues item items job key label
language launch lead level license limit line link list local location locked log login low
main maintenance manager manual message messages meeting method migration mobile mode model
name names network new note notes notice number object office online open order orders owner
page paid parent partner password payment pending period phone plan planned policy port
position post price primary priority private process product production profile progress
project projects public purchase quality quantity query queue rate record records reference
region release remote report reports request requested required resolved resource resources
response result results review risk role rule rules sale sales schedule scheduled score search
security server servers service services session setting settings setup severity share site
size source staff stage start state status step stock storage store subject submitted summary
supplier support system systems table tag target task tasks team teams template term terms
test testing text ticket tickets title token total track transfer type types unit unknown
update updated upgrade usage use user users value values vendor version view warning website
work workflow zone

ability access act add added advice age agree air allow almost along already answer appear
apply area arrive ask attention bad base basic become begin believe best better big bit black
blue book bring brown build buy car care carry cause centre center change child children city
clear cold come common consider continue control country course cover cut dark deal decide
deep develop different difficult direct discuss door draw drive early east easy eat economic
effect effort enter even example expect experience explain face fact fall family far fast
feel figure find fine finish fire follow food force free friend full game general get give go
good great green ground grow happen hard head health hear heart help high hold hope house
human idea important include increase indeed interest issue keep kind know land large late
later lead learn leave left life light little live long look lose lot love make man market
matter mean measure meet member mind miss money move movement music need never news nothing
offer old order paper part party pass pay people person picture place play point poor power
present problem program provide pull put question quick quickly read ready real reason
receive red remain remember report rest return right room run say school see seem sell send
sense serve set short show side sign simple simply small social sort speak special spend stand
stay stop story street strong student study sure take talk teach tell thing think thought
today top tree true try turn understand upon use usually wait walk want watch water way west
white whole wide win woman word world write wrong yes young

agenda attached attachment confirm discussed followup migrate migrated moved note noted
reviewed schedule shipped slipped standup sync synced update updates
`;

/** Lower-case words; callers fold case with String#toLowerCase before looking up. */
export const DICTIONARY: ReadonlySet<string> = new Set(WORDS.split(/\s+/).filter((w) => w !== ""));
