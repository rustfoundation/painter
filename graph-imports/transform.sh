#!/bin/bash

xsv select id,name data/crates.csv > f_crates.csv
sed -e 's/$/,Crate/' -i f_crates.csv
sed -e 's/^/c/' -i f_crates.csv
sed -i "1s/.*/crate_id:ID,name,:LABEL/" f_crates.csv

xsv select id,num data/versions.csv > f_versions.csv
sed -e 's/^/v/' -i f_versions.csv
sed -e 's/$/,CrateVersion/' -i f_versions.csv
sed -i "1s/.*/version_id:ID,version,:LABEL/" f_versions.csv

xsv select crate_id,id data/versions.csv > f_version_crate_link.csv
sed -e 's/$/,VERSION_OF/' -i f_version_crate_link.csv

cat f_version_crate_link.csv  | awk -F "," '{ print "c"$1",v"$2","$3}' > f_version_crate_link_new.csv
mv f_version_crate_link_new.csv f_version_crate_link.csv
sed -i "1s/.*/:START_ID,:END_ID,:TYPE/" f_version_crate_link.csv

xsv select version_id,crate_id,req data/dependencies.csv > f_dependency_link.csv
cat f_dependency_link.csv  | awk -vFPAT='([^,]*)|("[^"]+")' -vOFS=,  '{ print "v"$1",c"$2","$3}' > f_dependency_link_new.csv
mv f_dependency_link_new.csv f_dependency_link.csv
sed -e 's/$/,DEPENDS_ON/' -i f_dependency_link.csv
sed -i "1s/.*/:START_ID,:END_ID,req,:TYPE/" f_dependency_link.csv

# IMport
neo4j-admin database import full --nodes=/import/crates.io-db/f_crates.csv --nodes=/import/crates.io-db/f_versions.csv \
--relationships=/import/crates.io-db/f_version_crate_link.csv --relationships=/import/crates.io-db/f_dependency_link.csv  --overwrite-destination
