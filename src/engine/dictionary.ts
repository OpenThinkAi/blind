// A small built-in English word list for the dictionary-word ratio: the share
// of a column's words that are ordinary vocabulary. Lowercase ASCII only; the
// ratio is a coarse signal ("are these words or codes and names?"), not a
// spell checker. Fixed in source so the engine's output never depends on the
// environment.

const WORDS = `
a able about above accept access account across act action active add address admin after again against age
agent ago agree air all allow almost alone along already also always am amount an and annual another answer
any app apply approve approved april archive are area around arrive art as ask assign assigned at attach
august author auto available average away back backup bad balance bank base be because become been before
begin behind being below best better between big bill black blue board body book both box branch break bring
brown budget bug build building business busy but buy by call can cancel cancelled card care case cash
category cause center central change charge check child city claim class clear client close closed cloud code
cold color come comment common company complete completed config confirm contact content contract control copy
cost could count country course create created credit critical current customer cycle daily damage data date
day dead deal december default delete deleted deliver department deploy description design detail dev device
did different direct disabled do document does done down draft due during each early east edit education
effect either else email employee empty enable enabled end engineer enough enter entry environment error even
event every example expense expired export external fail failed false family far fast february fee feel field
file final finance find fine finish first fix fixed follow for form forward found free friday from front full
fund game general get give go good great green group grow guest had half hand happen hard has have he head
health hear help her here high hold home hot hour house how however human i idea if image impact important
in inactive include income info information input inside install internal into invoice is issue it item its
january job join july june just keep key kind know label land language large last late later lead learn least
leave left legal less letter level life light like limit line link list little live local lock log long look
lost low made main make manage manager many march market may me medium meet meeting member message method
middle might minor mobile model monday money month more morning most move much must my name national need net
network never new next night no none normal north not note notes nothing november now number object october
of off offer office often old on once one online only open operation option or order other our out output
over owner page paid part partner party pass password past pay payment pending people per person phone place
plan play point policy pool post power present price print priority private problem process product program
project public pull purchase push put quality quarter question queue quick quite rate rather reach read ready
real reason receive record red reference region regular rejected release remote remove report request
required resolved resource result return review right risk road role room rule run safe said sale same
saturday save say school score second section security see sell send senior sent september server service
session set setting share she short should show side sign simple since site size small so software some
something soon sort source south space special staff stage standard start state status step still stock stop
store story street strong student subject success such sunday supplier support sure system table take task
team tech term test than that the their them then there these they thing think this those through thursday
ticket time to today together too top total toward town track trade training transfer travel true try
tuesday type under unit unknown until up update updated upgrade urgent us use used user valid value vendor
version very view visit wait want warning was watch water way we wednesday week well were west what when
where which while white who why will with within without work worker world would write year yellow yes yet
you your zone
`;

export const DICTIONARY: ReadonlySet<string> = new Set(WORDS.split(/\s+/).filter((w) => w !== ""));
