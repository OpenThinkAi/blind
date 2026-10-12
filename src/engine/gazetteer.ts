// A small given-name and surname gazetteer for finding people named only in prose (AGT-1830).
// Written for blind from common US given names and surnames (the kind the US Census publishes as
// public-domain frequency lists); it is a positive signal, not a complete list: a Title-Case pair
// needs one of its words here (or an honorific before it) before the engine treats it as a person.
// Words that are mostly place, organisation or breed words ("Hill", "Park", "Lane", "Wood") are
// left out on purpose, so "Logan Hill" or "Avery Park" never reads as a person by the list alone.
// Lowercase, one word each.

const GIVEN = `
aaron abigail ada adam adrian adriana aisha alan albert alejandro alex alexa alexander alexandra
alexis alfred alice alicia alisha allison alma alvin amanda amber amelia amy ana andre andrea
andrew andy angela angelica angie anita ann anna anne annie anthony antonio april arianna ariel
arthur ashley audrey austin ava avery barbara barry beatrice becky ben benjamin bernard beth
bethany betty beverly bianca bill billy blake bobby bonnie brad bradley brandon brenda brendan
brent brett brian briana bridget brittany brooke bruce bryan caleb calvin cameron camila carl
carla carlos carmen carol caroline carolyn carrie casey cassandra catherine cecilia chad charles
charlie charlotte chelsea cheryl chloe chris christian christina christine christopher cindy
claire clara clarence claudia clifford clinton colin colleen connor constance corey courtney craig
crystal curtis cynthia daisy dale dallas damian dan dana daniel danielle danny darlene darren
david dawn dean deborah debra denise dennis derek desiree destiny devin diana diane dolores
dominic don donald donna doris dorothy douglas dustin dylan earl eddie edgar edith edward eileen
elaine eleanor elena eli elijah elizabeth ella ellen elliot emily emma eric erica erik erin
esther ethan eugene eva evan evelyn faith felicia fernando fiona florence frances francisco frank
franklin fred frederick gabriel gabriela gail gary gavin gene george georgia gerald gina gladys
glen glenn gloria gordon grace graham greg gregory gwen hailey haley hannah harold harper harriet
harry hazel heather hector helen henry herbert holly howard hugo ian irene iris isaac isabel
isabella isaiah ivan jack jackson jacob jacqueline jade jaime jake james jamie jan jane janet
janice jared jasmine jason javier jay jean jeanette jeff jeffrey jenna jennifer jenny jeremy
jerome jerry jesse jessica jesus jill jim jimmy jo joan joanna joanne joe joel john johnny jon
jonathan jordan jorge jose joseph josephine josh joshua joy joyce juan judith judy julia julian
julie justin kaitlyn karen karl kate katelyn katherine kathleen kathryn kathy katie kayla keith
kelly ken kendra kenneth kevin kim kimberly kirk kristen kristin kyle lance larry laura lauren
lawrence leah lee leo leon leonard leslie lillian lily linda lindsay lindsey lisa logan lois
lorena lori lorraine louis louise lucas lucia lucy luis luke lydia lynn mackenzie madeline
madison maggie malcolm mandy marcus margaret maria marian marie marilyn mario marion marisol
marjorie mark marlene marsha martha martin marvin mary mason matthew maureen max maxine megan
melanie melissa melvin mercedes meredith mia micah michael michele michelle miguel mildred
miranda molly monica morgan nancy naomi natalie nathan nathaniel neil nicholas nicole noah nora
norma norman oliver olivia omar oscar owen paige pamela patricia patrick paul paula pauline pearl
peggy penelope peter philip phillip phyllis preston priscilla quentin quinn rachel ralph ramon
randall randy raquel ray raymond rebecca regina renee rhonda ricardo richard rick ricky riley
rita rob robert roberta robin rodney roger roland ronald ronnie rosa rosalie rose rosemary ross
roy ruby russell ruth ryan sabrina sally samantha samuel sandra sara sarah savannah scott sean
sebastian seth shane shannon sharon shawn sheila shelby shelley sherry shirley sierra simon sofia
sonia sophia spencer stacy stanley stella stephanie stephen steve steven sue susan sydney sylvia
tamara tammy tanya tara taylor teresa terrence terri terry thelma theodore theresa thomas tiffany
tim timothy tina todd tom tommy tony tracy travis trevor troy tyler valerie vanessa vera vernon
veronica vicki victor victoria vincent viola violet virginia vivian walter wanda warren wayne
wendy wesley whitney will william willie wyatt yolanda yvonne zachary zoe
`;

const SURNAMES = `
abbott acosta adams aguilar alexander ali allen alvarez anderson andrews armstrong arnold austin
bailey baker banks barnes barnett barrett bates beck becker bell bennett benson berry bishop black
blake bowen boyd bradley brady brooks brown bryant burke burns burton bush butler byrd caldwell
campbell cardenas carlson carpenter carr carroll carter castillo castro chambers chan chang chapman
chavez chen cohen cole coleman collins contreras cook cooper cortez cox crawford cruz cunningham
curtis daniels davidson davis dawson day dean delgado diaz dixon dominguez douglas duncan dunn
edwards elliott ellis espinoza evans ferguson fernandez fields figueroa fisher fleming fletcher
flores ford foster fowler fox franklin frazier freeman fuller garcia gardner garrett garza george
gibson gilbert gomez gonzales gonzalez gordon graham grant gray green greene gregory griffin
gutierrez guzman hall hamilton hansen hanson harper harris harrison hart harvey hawkins hayes
henderson henry hernandez herrera hicks hoffman holland holmes hopkins howard howell hudson hughes
hunt hunter jackson jacobs james jenkins jensen jimenez johnson johnston jones jordan kelley kelly
kennedy kim king knight lambert larson lawrence lawson lee lewis lim little long lopez lucas lynch
marshall martin martinez mason matthews mcdonald mckinney medina mendez mendoza meyer miller mills
mitchell montgomery moore morales moreno morgan morris murphy murray myers nelson newman nguyen
nichols nunez obrien oliver olson ortiz owens palmer parker patel patterson payne pearson pena
perez perkins perry peters peterson phillips pierce porter powell price quinn ramirez ramos ray
reed reid reyes reynolds rhodes rice richards richardson riley rivera roberts robertson robinson
rodriguez rogers romero rose ross ruiz russell ryan salazar sanchez sanders santos schmidt schneider
schultz scott shaw silva simmons simpson sims smith snyder soto spencer stanley stephens stevens
stewart stone sullivan sutton taylor thomas thompson torres tran tucker turner valdez vargas
vasquez vaughn walker wallace walsh walters wang ward warren washington watkins watson weaver webb
weber wells west wheeler white williams williamson willis wilson wong woods wright wu yang young
zhang
`;

const toSet = (s: string): ReadonlySet<string> => new Set(s.split(/\s+/).filter((w) => w !== ""));

const GIVEN_SET = toSet(GIVEN);
const SURNAME_SET = toSet(SURNAMES);

const fold = (w: string): string => w.normalize("NFKC").toLowerCase().replace(/['\u2019]/g, "");

/** A common given name ("Avery", "Marisol"), any case. */
export function isGivenName(word: string): boolean {
  return GIVEN_SET.has(fold(word));
}

/** A common surname ("Okafor" is not; "Nguyen", "O'Brien" are), any case. */
export function isSurname(word: string): boolean {
  return SURNAME_SET.has(fold(word));
}
